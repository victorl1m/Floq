use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow};

const COLLAPSED_WIDTH: f64 = 220.0;
const EXPANDED_WIDTH: f64 = 440.0;
const COLLAPSED_HEIGHT: f64 = 40.0;
const MAX_HEIGHT: f64 = 560.0;
const TOP_GAP: f64 = 12.0;
const HIDE_DELAY_MS: u64 = 320;

/// True while the island was hidden (or its show was skipped) because a full-screen app is in front.
static FULLSCREEN_HIDDEN: AtomicBool = AtomicBool::new(false);

/// SHQueryUserNotificationState values that mean "do not disturb": busy (a full-screen app or a presentation),
/// a Direct3D full-screen game, or presentation mode.
fn quns_is_busy(state: i32) -> bool {
    matches!(state, 2..=4)
}

/// A window that fills its whole monitor (borderless full-screen games and videos included), by rectangle.
fn rect_covers(window: (i32, i32, i32, i32), monitor: (i32, i32, i32, i32)) -> bool {
    window.0 <= monitor.0 && window.1 <= monitor.1 && window.2 >= monitor.2 && window.3 >= monitor.3
}

#[cfg(windows)]
fn fullscreen_app_active_now() -> bool {
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
    };
    use windows::Win32::UI::Shell::SHQueryUserNotificationState;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
    };
    unsafe {
        if let Ok(state) = SHQueryUserNotificationState() {
            if quns_is_busy(state.0) {
                return true;
            }
        }
        // Fallback for borderless full-screen windows the shell does not flag.
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == std::process::id() {
            return false;
        }
        let mut class = [0u16; 64];
        let len = GetClassNameW(hwnd, &mut class);
        if len > 0 {
            let name = String::from_utf16_lossy(&class[..len as usize]);
            if matches!(name.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") {
                return false;
            }
        }
        let mut rect = windows::Win32::Foundation::RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return false;
        }
        rect_covers(
            (rect.left, rect.top, rect.right, rect.bottom),
            (
                info.rcMonitor.left,
                info.rcMonitor.top,
                info.rcMonitor.right,
                info.rcMonitor.bottom,
            ),
        )
    }
}

#[cfg(not(windows))]
fn fullscreen_app_active_now() -> bool {
    false
}

/// Whether a full-screen app (a game, a video, a presentation) is in front, so the island must stay out of the way.
/// Cached for a moment: the hover monitor asks every tick.
fn fullscreen_suppressed() -> bool {
    static CACHE: Mutex<Option<(std::time::Instant, bool)>> = Mutex::new(None);
    let now = std::time::Instant::now();
    if let Ok(mut cache) = CACHE.lock() {
        if let Some((at, value)) = *cache {
            if now.duration_since(at) < std::time::Duration::from_millis(400) {
                return value;
            }
        }
        let value = fullscreen_app_active_now();
        *cache = Some((now, value));
        return value;
    }
    false
}

struct IslandState {
    visibility_generation: u64,
    active: bool,
    expanded: bool,
    pinned: bool,
    height: f64,
    outside_since: Option<std::time::Instant>,
    last_non_empty_snapshot: Option<Value>,
}

impl Default for IslandState {
    fn default() -> Self {
        Self {
            visibility_generation: 0,
            active: false,
            expanded: false,
            pinned: false,
            height: COLLAPSED_HEIGHT,
            outside_since: None,
            last_non_empty_snapshot: None,
        }
    }
}

pub struct IslandRuntime(Mutex<IslandState>, Arc<AnimationState>);

#[derive(serde::Serialize)]
pub struct IslandViewport {
    width: f64,
    height: f64,
}

#[derive(Default)]
struct AnimationState {
    generation: AtomicU64,
    running: AtomicU64,
    pending: AtomicBool,
    rect: Mutex<Option<(i32, i32, i32, i32)>>,
}

impl Default for IslandRuntime {
    fn default() -> Self {
        Self(
            Mutex::new(IslandState::default()),
            Arc::new(AnimationState::default()),
        )
    }
}

fn allowed_caller(window: &WebviewWindow, label: &str) -> Result<(), String> {
    if window.label() == label {
        Ok(())
    } else {
        Err(format!(
            "This command is only available to the {label} window"
        ))
    }
}

fn clamped_height(height: f64) -> f64 {
    if height.is_finite() {
        height.clamp(COLLAPSED_HEIGHT, MAX_HEIGHT)
    } else {
        COLLAPSED_HEIGHT
    }
}

fn active_snapshot(snapshot: &Value) -> bool {
    if let Some(count) = snapshot.get("pendingCount").and_then(Value::as_u64) {
        return count > 0;
    }
    let mut found_queue = false;
    for key in ["items", "queue", "attention", "approvals", "decisions"] {
        if let Some(items) = snapshot.get(key).and_then(Value::as_array) {
            found_queue = true;
            if !items.is_empty() {
                return true;
            }
        }
    }
    !found_queue
}

fn update_snapshot_state(state: &mut IslandState, snapshot: Value, island_enabled: bool) -> bool {
    state.visibility_generation = state.visibility_generation.wrapping_add(1);
    let queue_active = active_snapshot(&snapshot);
    state.last_non_empty_snapshot = queue_active.then_some(snapshot);
    state.outside_since = None;
    state.active = island_enabled && queue_active;
    if !state.active {
        state.expanded = false;
        state.pinned = false;
        state.height = COLLAPSED_HEIGHT;
    }
    state.active
}

fn set_island_enabled(state: &mut IslandState, enabled: bool) -> Option<Value> {
    state.visibility_generation = state.visibility_generation.wrapping_add(1);
    if !enabled {
        state.active = false;
        state.expanded = false;
        state.pinned = false;
        state.height = COLLAPSED_HEIGHT;
        state.outside_since = None;
        return None;
    }

    let snapshot = state.last_non_empty_snapshot.clone()?;
    state.active = active_snapshot(&snapshot);
    state.outside_since = None;
    state.active.then_some(snapshot)
}

fn hide_is_current(state: &IslandState, generation: u64) -> bool {
    !state.active && state.visibility_generation == generation
}

// Intentionally log counts and state only: request text and answers may be sensitive.
fn diagnostic(app: &tauri::AppHandle, event: &str) {
    use std::io::Write;
    static LOG_LOCK: Mutex<()> = Mutex::new(());
    let Ok(_guard) = LOG_LOCK.lock() else {
        return;
    };
    let Ok(directory) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&directory);
    let path = directory.join("island.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() >= 256 * 1024) {
        let _ = std::fs::rename(&path, directory.join("island.log.1"));
        // Windows rename cannot replace an existing rotated file.
        if std::fs::metadata(&path).is_ok_and(|m| m.len() >= 256 * 1024) {
            let _ = std::fs::remove_file(directory.join("island.log.1"));
            let _ = std::fs::rename(&path, directory.join("island.log.1"));
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let _ = writeln!(file, "{time} {event}");
    }
}

fn physical_rect(window: &WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some((
        position.x,
        position.y,
        size.width as i32,
        size.height as i32,
    ))
}

fn contains(rect: (i32, i32, i32, i32), x: f64, y: f64) -> bool {
    x >= rect.0 as f64
        && y >= rect.1 as f64
        && x < (rect.0 + rect.2) as f64
        && y < (rect.1 + rect.3) as f64
}

fn bounds(window: &WebviewWindow, expanded: bool, height: f64) -> Option<(i32, i32, u32, u32)> {
    let monitor = window.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let desired_width = (if expanded {
        EXPANDED_WIDTH
    } else {
        COLLAPSED_WIDTH
    } * scale)
        .round()
        .max(1.0) as u32;
    let desired_height = (if expanded {
        clamped_height(height)
    } else {
        COLLAPSED_HEIGHT
    } * scale)
        .round()
        .max(1.0) as u32;
    let width = desired_width.min(area.size.width.max(1));
    let top_gap = (TOP_GAP * scale).round() as u32;
    let height = desired_height.min(area.size.height.saturating_sub(top_gap).max(1));
    let area_width = area.size.width as i32;
    let area_height = area.size.height as i32;
    let x = area.position.x + ((area_width - width as i32) / 2).max(0);
    let y = area.position.y + top_gap as i32;
    let x = x.clamp(
        area.position.x,
        area.position.x + (area_width - width as i32).max(0),
    );
    let y = y.clamp(
        area.position.y,
        area.position.y + (area_height - height as i32).max(0),
    );
    Some((x, y, width, height))
}

fn ease_out(progress: f64) -> f64 {
    let t = progress.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

fn corner_radius(height: u32, scale: f64, expanded: bool) -> f64 {
    if expanded {
        (34.0 * scale).min(height as f64 / 2.0)
    } else {
        height as f64 / 2.0
    }
}

#[cfg(windows)]
fn apply_region(
    window: &WebviewWindow,
    width: u32,
    height: u32,
    radius: f64,
) -> Result<(), String> {
    use windows::Win32::Graphics::Dwm::{
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND, DwmSetWindowAttribute,
    };
    use windows::Win32::Graphics::Gdi::SetWindowRgn;

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let diameter = (radius * 2.0).round().max(1.0) as i32;
    unsafe {
        let preference = DWMWCP_DONOTROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const _ as *const _,
            std::mem::size_of_val(&preference) as u32,
        );
        // The CSS capsule is anti-aliased over a transparent window; a native region would
        // clip it with hard edges and leave a visible rectangle, so clear any region.
        let _ = SetWindowRgn(hwnd, None, true);
        let _ = (width, height, diameter);
    }
    Ok(())
}

#[cfg(not(windows))]
fn apply_region(_: &WebviewWindow, _: u32, _: u32, _: f64) -> Result<(), String> {
    Ok(())
}

fn apply_frame(
    window: &WebviewWindow,
    frame: (i32, i32, u32, u32),
    radius: f64,
) -> Result<(), String> {
    let (x, y, width, height) = frame;
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    apply_region(window, width, height, radius)?;
    if let Ok(mut rect) = window.app_handle().state::<IslandRuntime>().1.rect.lock() {
        *rect = Some((x, y, width as i32, height as i32));
    }
    Ok(())
}

fn apply_bounds(window: &WebviewWindow, expanded: bool, height: f64) -> Result<(), String> {
    let frame =
        bounds(window, expanded, height).ok_or("No display is available for the island window")?;
    let scale = window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    apply_frame(window, frame, corner_radius(frame.3, scale, expanded))
}

#[cfg(windows)]
fn set_visible_without_activation(window: &WebviewWindow, visible: bool) -> Result<(), String> {
    if visible && fullscreen_suppressed() {
        // Never pop over a game or a full-screen video; the monitor shows it once the full-screen app is gone.
        FULLSCREEN_HIDDEN.store(true, Ordering::SeqCst);
        diagnostic(window.app_handle(), "show suppressed (full-screen app)");
        return Ok(());
    }
    diagnostic(window.app_handle(), if visible { "show" } else { "hide" });
    use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNOACTIVATE, ShowWindow};
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        let _ = ShowWindow(hwnd, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
    }
    if visible {
        keep_on_top(window);
    }
    Ok(())
}

/// Re-assert the topmost z-order without activating, so the island stays above the
/// main Floq window (and everything else) whether or not the app is visible or focused.
#[cfg(windows)]
pub fn keep_on_top(window: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos,
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
}

#[cfg(not(windows))]
pub fn keep_on_top(_: &WebviewWindow) {}

#[cfg(not(windows))]
fn set_visible_without_activation(window: &WebviewWindow, visible: bool) -> Result<(), String> {
    if visible && fullscreen_suppressed() {
        FULLSCREEN_HIDDEN.store(true, Ordering::SeqCst);
        return Ok(());
    }
    diagnostic(window.app_handle(), if visible { "show" } else { "hide" });
    if visible {
        window.show()
    } else {
        window.hide()
    }
    .map_err(|error| error.to_string())
}

fn cancel_animation(animation: &AnimationState) {
    animation.generation.fetch_add(1, Ordering::SeqCst);
    animation.running.store(0, Ordering::SeqCst);
}

fn animate_bounds(
    window: WebviewWindow,
    animation: Arc<AnimationState>,
    expanded: bool,
    height: f64,
    from_expanded: bool,
) {
    let generation = animation.generation.fetch_add(1, Ordering::SeqCst) + 1;
    animation.running.store(generation, Ordering::SeqCst);
    // Resolve native window information on the main thread before starting the worker.
    let Some(target) = bounds(&window, expanded, height) else {
        animation.running.store(0, Ordering::SeqCst);
        return;
    };
    let start = animation
        .rect
        .lock()
        .ok()
        .and_then(|rect| *rect)
        .or_else(|| physical_rect(&window));
    let Some(start) = start else {
        animation.running.store(0, Ordering::SeqCst);
        return;
    };
    let scale = window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let start_radius = corner_radius(start.3.max(1) as u32, scale, from_expanded);
    let end_radius = corner_radius(target.3, scale, expanded);
    let app = window.app_handle().clone();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        loop {
            if animation.generation.load(Ordering::SeqCst) != generation {
                break;
            }
            let t = ease_out(started.elapsed().as_secs_f64() / 0.240);
            let lerp = |a: f64, b: f64| a + (b - a) * t;
            let frame = (
                lerp(start.0 as f64, target.0 as f64).round() as i32,
                lerp(start.1 as f64, target.1 as f64).round() as i32,
                lerp(start.2 as f64, target.2 as f64).round().max(1.0) as u32,
                lerp(start.3 as f64, target.3 as f64).round().max(1.0) as u32,
            );
            if !animation.pending.swap(true, Ordering::SeqCst) {
                let posted_animation = animation.clone();
                let posted_window = window.clone();
                let radius = lerp(start_radius, end_radius);
                let final_frame = t >= 1.0;
                if app
                    .run_on_main_thread(move || {
                        if posted_animation.generation.load(Ordering::SeqCst) == generation {
                            let _ = apply_frame(&posted_window, frame, radius);
                            if final_frame {
                                let _ = posted_animation.running.compare_exchange(
                                    generation,
                                    0,
                                    Ordering::SeqCst,
                                    Ordering::SeqCst,
                                );
                            }
                        }
                        posted_animation.pending.store(false, Ordering::SeqCst);
                    })
                    .is_err()
                {
                    animation.pending.store(false, Ordering::SeqCst);
                    let _ = animation.running.compare_exchange(
                        generation,
                        0,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    );
                    break;
                }
                if final_frame {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
    });
}

#[tauri::command]
pub fn island_publish(
    window: WebviewWindow,
    app: tauri::AppHandle,
    runtime: tauri::State<'_, IslandRuntime>,
    preferences: tauri::State<'_, crate::desktop::DesktopState>,
    snapshot: Value,
) -> Result<(), String> {
    allowed_caller(&window, "main")?;
    let enabled = preferences
        .preferences
        .lock()
        .map_err(|_| "Preferences unavailable")?
        .island_enabled;
    let (active, expanded, height, was_active, visibility_generation) = {
        let mut state = runtime.0.lock().map_err(|_| "Island state unavailable")?;
        let was_active = state.active;
        let active = update_snapshot_state(&mut state, snapshot.clone(), enabled);
        (
            active,
            state.expanded,
            state.height,
            was_active,
            state.visibility_generation,
        )
    };
    diagnostic(
        &app,
        &format!("publish active={active} expanded={expanded} generation={visibility_generation}"),
    );
    let island = app
        .get_webview_window("island")
        .ok_or("Island window is unavailable")?;
    island
        .emit("island:snapshot", snapshot)
        .map_err(|error| error.to_string())?;
    if active {
        island
            .set_ignore_cursor_events(false)
            .map_err(|error| error.to_string())?;
        if !was_active {
            apply_bounds(&island, expanded, height)?;
        }
        if !was_active || !island.is_visible().unwrap_or(false) {
            set_visible_without_activation(&island, true)?;
        }
    } else {
        cancel_animation(&runtime.1);
        let _ = island.set_ignore_cursor_events(false);
        // Let the frontend play its exit animation before the OS window goes away.
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(HIDE_DELAY_MS));
            let main_handle = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                // Re-check after dispatch: a new publish may have arrived while this
                // callback waited in the Windows event queue. No window call under lock.
                let current = main_handle
                    .state::<IslandRuntime>()
                    .0
                    .lock()
                    .map(|state| hide_is_current(&state, visibility_generation))
                    .unwrap_or(false);
                if current {
                    if let Some(window) = main_handle.get_webview_window("island") {
                        let _ = set_visible_without_activation(&window, false);
                    }
                } else {
                    diagnostic(&main_handle, "hide cancelled");
                }
            });
        });
    }
    Ok(())
}

pub fn set_enabled(
    app: &tauri::AppHandle,
    runtime: &IslandRuntime,
    enabled: bool,
) -> Result<(), String> {
    diagnostic(app, &format!("enabled={enabled}"));
    let (snapshot, expanded, height) = {
        let mut state = runtime.0.lock().map_err(|_| "Island state unavailable")?;
        let snapshot = set_island_enabled(&mut state, enabled);
        (snapshot, state.expanded, state.height)
    };
    let Some(window) = app.get_webview_window("island") else {
        return Ok(());
    };
    let Some(snapshot) = snapshot else {
        cancel_animation(&runtime.1);
        set_visible_without_activation(&window, false)?;
        return Ok(());
    };
    window
        .emit("island:snapshot", snapshot)
        .map_err(|error| error.to_string())?;
    window
        .set_ignore_cursor_events(false)
        .map_err(|error| error.to_string())?;
    apply_bounds(&window, expanded, height)?;
    set_visible_without_activation(&window, true)
}

#[tauri::command]
pub fn island_intent(
    window: WebviewWindow,
    app: tauri::AppHandle,
    intent: Value,
) -> Result<(), String> {
    allowed_caller(&window, "island")?;
    app.get_webview_window("main")
        .ok_or("Main window is unavailable")?
        .emit("island:intent", intent)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn island_set_layout(
    window: WebviewWindow,
    runtime: tauri::State<'_, IslandRuntime>,
    expanded: bool,
    height: f64,
    pinned: bool,
) -> Result<Option<IslandViewport>, String> {
    allowed_caller(&window, "island")?;
    let height = clamped_height(height);
    {
        let mut state = runtime.0.lock().map_err(|_| "Island state unavailable")?;
        if !state.active {
            return Ok(None);
        }
        state.expanded = expanded;
        state.pinned = pinned;
        state.height = height;
        state.outside_since = None;
    }
    window
        .set_ignore_cursor_events(false)
        .map_err(|error| error.to_string())?;
    diagnostic(
        window.app_handle(),
        &format!("layout expanded={expanded} height={height} pinned={pinned}"),
    );
    // The frontend owns the capsule morph and delays shrinking until it finishes.
    // A second native resize animation clips/reflows content and fights rapid reopen.
    cancel_animation(&runtime.1);
    apply_bounds(&window, expanded, height)?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    Ok(Some(IslandViewport {
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    }))
}

pub fn create_window(
    app: &tauri::AppHandle,
    has_native_material: bool,
) -> tauri::Result<WebviewWindow> {
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "island",
        WebviewUrl::App("index.html?window=island".into()),
    )
    .title("Floq Island")
    .inner_size(COLLAPSED_WIDTH, COLLAPSED_HEIGHT)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .shadow(false)
    .background_color(tauri::window::Color(245, 246, 248, 255));
    #[cfg(any(windows, target_os = "macos"))]
    let builder = if has_native_material {
        builder
            .transparent(true)
            .background_color(tauri::window::Color(0, 0, 0, 0))
    } else {
        builder
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = has_native_material;
    let window = builder.build()?;
    let _ = apply_bounds(&window, false, COLLAPSED_HEIGHT);
    let _ = window.set_ignore_cursor_events(false);
    Ok(window)
}

pub fn start_hover_monitor(app: tauri::AppHandle) {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        std::thread::spawn(move || {
            let pending = Arc::new(AtomicBool::new(false));
            loop {
                std::thread::sleep(std::time::Duration::from_millis(75));
                if pending.swap(true, Ordering::SeqCst) {
                    continue;
                }
                let tick_pending = pending.clone();
                let tick_app = app.clone();
                let animation = app.state::<IslandRuntime>().1.clone();
                let generation = animation.generation.load(Ordering::SeqCst);
                if app
                    .run_on_main_thread(move || {
                        if animation.generation.load(Ordering::SeqCst) == generation {
                            hover_tick(&tick_app);
                        }
                        tick_pending.store(false, Ordering::SeqCst);
                    })
                    .is_err()
                {
                    pending.store(false, Ordering::SeqCst);
                }
            }
        });
    });
}

fn hover_tick(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("island") else {
        return;
    };
    // Never hold the state mutex across a window call: on Windows those calls
    // marshal to the main thread, which may itself be waiting on this mutex
    // inside a sync command (that deadlock froze the whole app on Send).
    let (active, pinned, expanded, height, outside_since) = {
        let runtime = app.state::<IslandRuntime>();
        let Ok(state) = runtime.0.lock() else {
            return;
        };
        (
            state.active,
            state.pinned,
            state.expanded,
            state.height,
            state.outside_since,
        )
    };
    if active {
        let visible = window.is_visible().unwrap_or(false);
        if fullscreen_suppressed() {
            // A game or full-screen video is in front: step aside (the request keeps waiting) and never touch z-order.
            if visible {
                FULLSCREEN_HIDDEN.store(true, Ordering::SeqCst);
                diagnostic(app, "hide (full-screen app)");
                let _ = set_visible_without_activation(&window, false);
            }
            return;
        }
        if FULLSCREEN_HIDDEN.swap(false, Ordering::SeqCst) && !visible {
            diagnostic(app, "show (full-screen app gone)");
            let _ = set_visible_without_activation(&window, true);
            return;
        }
    }
    if !active || !window.is_visible().unwrap_or(false) {
        return;
    }
    keep_on_top(&window);
    if pinned {
        return;
    }
    let animating = app
        .state::<IslandRuntime>()
        .1
        .running
        .load(Ordering::SeqCst)
        != 0;
    let desired = if animating {
        None
    } else {
        bounds(&window, expanded, height)
    };
    let cached = app
        .state::<IslandRuntime>()
        .1
        .rect
        .lock()
        .ok()
        .and_then(|rect| *rect);
    if let Some((x, y, width, h)) = desired {
        if cached != Some((x, y, width as i32, h as i32)) {
            let _ = apply_bounds(&window, expanded, height);
        }
    }
    let Ok(cursor) = app.cursor_position() else {
        return;
    };
    let inside = app
        .state::<IslandRuntime>()
        .1
        .rect
        .lock()
        .ok()
        .and_then(|rect| *rect)
        .is_some_and(|rect| contains(rect, cursor.x, cursor.y));
    let next = if inside && !expanded {
        Some(true)
    } else if expanded && !inside {
        let since = outside_since.unwrap_or_else(std::time::Instant::now);
        if since.elapsed() >= std::time::Duration::from_millis(300) {
            Some(false)
        } else {
            if outside_since.is_none() {
                if let Ok(mut state) = app.state::<IslandRuntime>().0.lock() {
                    state.outside_since = Some(since);
                }
            }
            None
        }
    } else {
        if inside && outside_since.is_some() {
            if let Ok(mut state) = app.state::<IslandRuntime>().0.lock() {
                state.outside_since = None;
            }
        }
        None
    };
    if let Some(now_expanded) = next {
        diagnostic(app, &format!("hover expanded={now_expanded}"));
        if let Ok(mut state) = app.state::<IslandRuntime>().0.lock() {
            // Keep applied geometry intact until the frontend finishes its morph.
            // Updating expanded here would let the next tick shrink it too early.
            state.outside_since = (!now_expanded).then(std::time::Instant::now);
        }
        let _ = window.set_ignore_cursor_events(false);
        let _ = window.emit(
            "island:hover",
            serde_json::json!({"expanded": now_expanded}),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        IslandState, active_snapshot, clamped_height, contains, corner_radius, ease_out,
        set_island_enabled, update_snapshot_state,
    };
    use serde_json::json;

    #[test]
    fn busy_notification_states_suppress_the_island() {
        use super::{quns_is_busy, rect_covers};
        for busy in [2, 3, 4] {
            assert!(quns_is_busy(busy), "{busy}");
        }
        for free in [0, 1, 5, 6, 7] {
            assert!(!quns_is_busy(free), "{free}");
        }
        let monitor = (0, 0, 1920, 1080);
        assert!(rect_covers((0, 0, 1920, 1080), monitor));
        assert!(rect_covers((-8, -8, 1928, 1088), monitor));
        assert!(!rect_covers((0, 0, 1920, 1040), monitor), "a maximized window leaves the taskbar");
        assert!(!rect_covers((100, 100, 900, 700), monitor));
    }

    #[test]
    fn stale_hide_cannot_hide_a_new_active_or_empty_generation() {
        let mut state = IslandState::default();
        update_snapshot_state(&mut state, json!({"items": []}), true);
        let stale = state.visibility_generation;
        assert!(super::hide_is_current(&state, stale));
        update_snapshot_state(&mut state, json!({"items": [{"id": "a"}]}), true);
        assert!(!super::hide_is_current(&state, stale));
        update_snapshot_state(&mut state, json!({"items": []}), true);
        assert!(!super::hide_is_current(&state, stale));
        assert!(super::hide_is_current(&state, state.visibility_generation));
    }

    #[test]
    fn easing_clamps_and_reaches_target_smoothly() {
        assert_eq!(ease_out(-1.0), 0.0);
        assert_eq!(ease_out(0.0), 0.0);
        assert_eq!(ease_out(0.5), 0.875);
        assert_eq!(ease_out(1.0), 1.0);
        assert_eq!(ease_out(2.0), 1.0);
    }

    #[test]
    fn radius_tracks_physical_height_and_scale() {
        assert_eq!(corner_radius(60, 1.5, false), 30.0);
        assert_eq!(corner_radius(300, 1.5, true), 39.0);
        assert_eq!(corner_radius(40, 2.0, true), 20.0);
    }

    #[test]
    fn clamps_island_height_to_supported_logical_range() {
        assert_eq!(clamped_height(20.0), 40.0);
        assert_eq!(clamped_height(900.0), 560.0);
        assert_eq!(clamped_height(f64::NAN), 40.0);
    }

    #[test]
    fn cursor_rectangle_supports_negative_monitor_origins() {
        assert!(contains((-1920, 0, 400, 60), -1800.0, 30.0));
        assert!(!contains((-1920, 0, 400, 60), -1520.0, 30.0));
    }

    #[test]
    fn empty_or_disconnected_queue_is_not_active() {
        assert!(!active_snapshot(
            &json!({"connected": true, "pendingCount": 0})
        ));
        assert!(active_snapshot(
            &json!({"connected": false, "pendingCount": 2})
        ));
        assert!(active_snapshot(
            &json!({"connected": true, "pendingCount": 1})
        ));
        assert!(active_snapshot(
            &json!({"connected": true, "approvals": [], "decisions": [{"id": "d1"}]})
        ));
    }

    #[test]
    fn active_snapshot_preserves_expansion_and_input_pin() {
        let mut state = IslandState {
            active: true,
            expanded: true,
            pinned: true,
            height: 280.0,
            ..IslandState::default()
        };
        let snapshot = json!({"connected": true, "items": [{"id": "a1"}], "busy": ["a1"]});

        assert!(update_snapshot_state(&mut state, snapshot, true));
        assert!(state.expanded);
        assert!(state.pinned);
        assert_eq!(state.height, 280.0);
    }

    #[test]
    fn enabling_restores_last_non_empty_snapshot() {
        let mut state = IslandState::default();
        let snapshot = json!({"connected": true, "items": [{"id": "a1"}]});

        assert!(!update_snapshot_state(&mut state, snapshot.clone(), false));
        assert!(!state.active);
        assert_eq!(set_island_enabled(&mut state, true), Some(snapshot));
        assert!(state.active);
    }

    #[test]
    fn disabled_preference_keeps_later_snapshots_hidden() {
        let mut state = IslandState::default();
        let snapshot = json!({"connected": true, "items": [{"id": "a1"}]});

        assert!(update_snapshot_state(&mut state, snapshot.clone(), true));
        assert_eq!(set_island_enabled(&mut state, false), None);
        assert!(!update_snapshot_state(&mut state, snapshot, false));
        assert!(!state.active);
        assert!(state.last_non_empty_snapshot.is_some());
    }
}
