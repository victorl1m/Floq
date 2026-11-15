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

/// Where a full-screen app (if any) is: on a known monitor (its origin), or somewhere unknown (the shell says
/// "busy" but no foreground window to locate it by: be conservative and suppress everywhere).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FullscreenOn {
    Nowhere,
    Anywhere,
    Monitor((i32, i32)),
}

/// Pure: does a full-screen app suppress the island on `target` (the monitor it is shown on, by origin)?
fn suppresses(fullscreen: FullscreenOn, target: Option<(i32, i32)>) -> bool {
    match fullscreen {
        FullscreenOn::Nowhere => false,
        FullscreenOn::Anywhere => true,
        FullscreenOn::Monitor(origin) => target.map_or(true, |t| t == origin),
    }
}

/// Pure: index of the monitor the island should appear on. `monitors` are physical (x, y, width, height).
/// Order: the monitor that contains the cursor, then the one containing the foreground window's center,
/// then the primary monitor (`primary`), then the first one.
fn choose_monitor(
    monitors: &[(i32, i32, u32, u32)],
    cursor: Option<(f64, f64)>,
    foreground: Option<(f64, f64)>,
    primary: Option<usize>,
) -> Option<usize> {
    let find = |point: Option<(f64, f64)>| {
        let (x, y) = point?;
        monitors.iter().position(|m| contains((m.0, m.1, m.2 as i32, m.3 as i32), x, y))
    };
    find(cursor)
        .or_else(|| find(foreground))
        .or(primary.filter(|&i| i < monitors.len()))
        .or(if monitors.is_empty() { None } else { Some(0) })
}

/// Origin of the monitor the island is (or will be) shown on; `None` = primary monitor.
static TARGET_MONITOR: Mutex<Option<(i32, i32)>> = Mutex::new(None);

fn target_origin() -> Option<(i32, i32)> {
    TARGET_MONITOR.lock().ok().and_then(|t| *t)
}

/// The monitor the island lives on right now: the chosen target if it still exists, else the primary one.
fn island_monitor(window: &WebviewWindow) -> Option<tauri::Monitor> {
    if let Some(origin) = target_origin() {
        if let Ok(monitors) = window.available_monitors() {
            if let Some(found) = monitors
                .into_iter()
                .find(|m| (m.position().x, m.position().y) == origin)
            {
                return Some(found);
            }
        }
    }
    window.primary_monitor().ok().flatten()
}

#[cfg(windows)]
fn foreground_center() -> Option<(f64, f64)> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut rect = windows::Win32::Foundation::RECT::default();
        GetWindowRect(hwnd, &mut rect).ok()?;
        Some((
            (rect.left + rect.right) as f64 / 2.0,
            (rect.top + rect.bottom) as f64 / 2.0,
        ))
    }
}

#[cfg(not(windows))]
fn foreground_center() -> Option<(f64, f64)> {
    None
}

/// Pick the monitor for the next show (the one with the cursor, else the foreground window's, else primary)
/// and remember it. Called when the island becomes visible, never while it is open.
fn pick_target_monitor(app: &tauri::AppHandle, window: &WebviewWindow) {
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    let rects: Vec<(i32, i32, u32, u32)> = monitors
        .iter()
        .map(|m| (m.position().x, m.position().y, m.size().width, m.size().height))
        .collect();
    let primary = window.primary_monitor().ok().flatten().and_then(|p| {
        monitors
            .iter()
            .position(|m| m.position() == p.position() && m.size() == p.size())
    });
    let cursor = app.cursor_position().ok().map(|c| (c.x, c.y));
    let chosen = choose_monitor(&rects, cursor, foreground_center(), primary)
        .map(|i| (rects[i].0, rects[i].1));
    if let Ok(mut target) = TARGET_MONITOR.lock() {
        *target = chosen;
    }
    // The full-screen verdict depends on the target monitor.
    if let Ok(mut cache) = SUPPRESS_CACHE.lock() {
        *cache = None;
    }
    diagnostic(app, &format!("monitor target={chosen:?}"));
}

#[cfg(windows)]
fn fullscreen_app_active_now() -> FullscreenOn {
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
    };
    use windows::Win32::UI::Shell::SHQueryUserNotificationState;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsZoomed,
    };
    unsafe {
        // Our own window in front (the user opened Floq) never suppresses the island, even while a video
        // plays full screen on another monitor and the shell still reports "busy".
        let hwnd = GetForegroundWindow();
        let mut pid = 0u32;
        if !hwnd.0.is_null() {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == std::process::id() {
                return FullscreenOn::Nowhere;
            }
        }
        let shell_busy = SHQueryUserNotificationState()
            .map(|state| quns_is_busy(state.0))
            .unwrap_or(false);
        let busy_here = |monitor_origin: Option<(i32, i32)>| match monitor_origin {
            Some(origin) => FullscreenOn::Monitor(origin),
            None => FullscreenOn::Anywhere,
        };
        // Fallback for borderless full-screen windows the shell does not flag.
        if hwnd.0.is_null() {
            return if shell_busy { FullscreenOn::Anywhere } else { FullscreenOn::Nowhere };
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let origin = GetMonitorInfoW(monitor, &mut info)
            .as_bool()
            .then_some((info.rcMonitor.left, info.rcMonitor.top));
        if shell_busy {
            return busy_here(origin);
        }
        let mut class = [0u16; 64];
        let len = GetClassNameW(hwnd, &mut class);
        if len > 0 {
            let name = String::from_utf16_lossy(&class[..len as usize]);
            if matches!(name.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") {
                return FullscreenOn::Nowhere;
            }
        }
        // A merely maximized app covers the monitor when the taskbar auto-hides; that is not full screen.
        if IsZoomed(hwnd).as_bool() {
            return FullscreenOn::Nowhere;
        }
        let mut rect = windows::Win32::Foundation::RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() || origin.is_none() {
            return FullscreenOn::Nowhere;
        }
        let covers = rect_covers(
            (rect.left, rect.top, rect.right, rect.bottom),
            (
                info.rcMonitor.left,
                info.rcMonitor.top,
                info.rcMonitor.right,
                info.rcMonitor.bottom,
            ),
        );
        if covers { busy_here(origin) } else { FullscreenOn::Nowhere }
    }
}

#[cfg(not(windows))]
fn fullscreen_app_active_now() -> FullscreenOn {
    FullscreenOn::Nowhere
}

/// Whether a full-screen app (a game, a video, a presentation) is in front ON THE ISLAND'S MONITOR, so the island must stay out of the way.
/// Cached for a moment: the hover monitor asks every tick.
fn fullscreen_suppressed() -> bool {
    let now = std::time::Instant::now();
    let target = target_origin();
    if let Ok(mut cache) = SUPPRESS_CACHE.lock() {
        if let Some((at, value)) = *cache {
            if now.duration_since(at) < std::time::Duration::from_millis(400) {
                return suppresses(value, target);
            }
        }
        let value = fullscreen_app_active_now();
        *cache = Some((now, value));
        return suppresses(value, target);
    }
    false
}

static SUPPRESS_CACHE: Mutex<Option<(std::time::Instant, FullscreenOn)>> = Mutex::new(None);

/// The main Floq window gained focus or was shown/restored: reshow a pending island right away,
/// bypassing the suppression cache. Safe to call from any window event.
pub fn on_main_window_focus(app: &tauri::AppHandle) {
    if let Ok(mut cache) = SUPPRESS_CACHE.lock() {
        *cache = None;
    }
    if !FULLSCREEN_HIDDEN.load(Ordering::SeqCst) {
        return;
    }
    let active = app
        .state::<IslandRuntime>()
        .0
        .lock()
        .map(|state| state.active)
        .unwrap_or(false);
    if !active {
        return;
    }
    let Some(window) = app.get_webview_window("island") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        FULLSCREEN_HIDDEN.store(false, Ordering::SeqCst);
        return;
    }
    if fullscreen_suppressed() {
        return;
    }
    FULLSCREEN_HIDDEN.store(false, Ordering::SeqCst);
    diagnostic(app, "show (main window focused)");
    let _ = set_visible_without_activation(&window, true);
}

/// Fallback while the island is suppressed by a full-screen app: flash the main window's taskbar button
/// (no focus steal, nothing drawn over the full-screen app).
fn flash_main_for_pending(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

struct IslandState {
    visibility_generation: u64,
    active: bool,
    expanded: bool,
    pinned: bool,
    height: f64,
    outside_since: Option<std::time::Instant>,
    last_non_empty_snapshot: Option<Value>,
    /// When the OS window was last shown for this visibility period; `None` while hidden.
    shown_at: Option<std::time::Instant>,
    /// True once the island webview reported a layout since the last show or recovery.
    layout_acked: bool,
    /// Recovery attempts since the last ack (0 = none yet).
    recoveries: u32,
    last_recovery: Option<std::time::Instant>,
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
            shown_at: None,
            layout_acked: false,
            recoveries: 0,
            last_recovery: None,
        }
    }
}

/// How long a shown island may stay silent before the watchdog steps in.
const ACK_TIMEOUT_MS: u128 = 1500;
/// Never recover more often than this.
const RECOVERY_COOLDOWN_MS: u128 = 10_000;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum WatchdogAction {
    None,
    Reload,
    Recreate,
}

/// Pure decision for the island watchdog. `since_shown_ms` is None while the window is hidden.
fn watchdog_action(
    since_shown_ms: Option<u128>,
    acked: bool,
    recoveries: u32,
    since_recovery_ms: Option<u128>,
) -> WatchdogAction {
    let Some(shown) = since_shown_ms else {
        return WatchdogAction::None;
    };
    if acked || shown < ACK_TIMEOUT_MS {
        return WatchdogAction::None;
    }
    if since_recovery_ms.is_some_and(|elapsed| elapsed < RECOVERY_COOLDOWN_MS) {
        return WatchdogAction::None;
    }
    if recoveries == 0 {
        WatchdogAction::Reload
    } else {
        WatchdogAction::Recreate
    }
}

fn mark_shown(app: &tauri::AppHandle, visible: bool) {
    if let Ok(mut state) = app.state::<IslandRuntime>().0.lock() {
        if visible {
            // Keep the timer of an already-running show; only a fresh show restarts it.
            if state.shown_at.is_none() {
                state.shown_at = Some(std::time::Instant::now());
                state.layout_acked = false;
                state.recoveries = 0;
            }
        } else {
            state.shown_at = None;
            state.layout_acked = false;
            state.recoveries = 0;
        }
    }
}

fn watchdog_tick(app: &tauri::AppHandle) {
    let runtime = app.state::<IslandRuntime>();
    let action = {
        let Ok(mut state) = runtime.0.lock() else {
            return;
        };
        if !state.active {
            return;
        }
        let action = watchdog_action(
            state.shown_at.map(|t| t.elapsed().as_millis()),
            state.layout_acked,
            state.recoveries,
            state.last_recovery.map(|t| t.elapsed().as_millis()),
        );
        if action != WatchdogAction::None {
            state.recoveries += 1;
            state.last_recovery = Some(std::time::Instant::now());
            state.shown_at = Some(std::time::Instant::now());
            state.layout_acked = false;
        }
        action
    };
    // Log only. Reloading or recreating the island from here misfired on a healthy island (the page does not
    // always report a layout after a show), blanking it and leaving an invisible window over the top of the screen.
    match action {
        WatchdogAction::None => {}
        WatchdogAction::Reload | WatchdogAction::Recreate => {
            diagnostic(app, "show without layout ack (no recovery action)");
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
    let monitor = island_monitor(window)?;
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
    let scale = island_monitor(window)
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    apply_frame(window, frame, corner_radius(frame.3, scale, expanded))
}

/// Show or hide the island window. This is the ONLY way visibility may change.
///
/// tao landmine: whenever ANY tao window flag actually changes (click-through, focusable, always_on_top,
/// resizable, maximized, decorations, shadow, ...), tao's `apply_diff` runs `ShowWindow(SW_HIDE)` if its own
/// VISIBLE flag is false. We show the island with a raw `ShowWindow(SW_SHOWNOACTIVATE)`, so tao always
/// believes it is hidden and such a setter hides the island silently, with no log line. That caused the
/// original "island vanished on hover". Rule: never call a tao window setter on the island except
/// `set_size` / `set_position`; visibility goes only through this function.
#[cfg(windows)]
fn set_visible_without_activation(window: &WebviewWindow, visible: bool) -> Result<(), String> {
    if visible && fullscreen_suppressed() {
        // Never pop over a game or a full-screen video; the monitor shows it once the full-screen app is gone.
        FULLSCREEN_HIDDEN.store(true, Ordering::SeqCst);
        diagnostic(window.app_handle(), "show suppressed (full-screen app)");
        return Ok(());
    }
    diagnostic(window.app_handle(), if visible { "show" } else { "hide" });
    mark_shown(window.app_handle(), visible);
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
    mark_shown(window.app_handle(), visible);
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
    let scale = island_monitor(&window)
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
        if !was_active {
            pick_target_monitor(&app, &island);
            apply_bounds(&island, expanded, height)?;
        }
        if !was_active || !island.is_visible().unwrap_or(false) {
            set_visible_without_activation(&island, true)?;
            if !was_active && FULLSCREEN_HIDDEN.load(Ordering::SeqCst) && !island.is_visible().unwrap_or(false) {
                // A new request arrived while a full-screen app hides the island: make it noticeable anyway.
                flash_main_for_pending(&app);
            }
        }
    } else {
        cancel_animation(&runtime.1);
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
    pick_target_monitor(app, &window);
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
    let main = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    // Clicking a notification (or its action) brings Floq to the front before the deep link runs.
    if intent.get("type").and_then(Value::as_str) == Some("notification")
        && intent.get("action").and_then(Value::as_str) == Some("open")
    {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    main.emit("island:intent", intent)
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
        state.layout_acked = true;
        state.recoveries = 0;
    }
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
    // A hidden island webview must keep running: WebView2 otherwise suspends it after hours hidden.
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
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
    Ok(window)
}

pub fn start_hover_monitor(app: tauri::AppHandle) {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let watch_app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let tick_app = watch_app.clone();
            let _ = watch_app.run_on_main_thread(move || watchdog_tick(&tick_app));
        });
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

/// True when the island should be on screen (active, nothing suppressing it) but the OS window is hidden.
fn needs_reshow(active: bool, visible: bool, fullscreen_hidden: bool, fullscreen_suppressed: bool) -> bool {
    active && !visible && !fullscreen_hidden && !fullscreen_suppressed
}

/// Rate limit for the self-heal re-show (monotonic clock). Returns Some(log_it): the first 3 attempts
/// are always logged; after that the show is still retried every 1 s but logged at most once per 10 s
/// (the count is per process, so a persistently failing re-show cannot flood island.log).
fn reshow_due() -> Option<bool> {
    static BASE: OnceLock<std::time::Instant> = OnceLock::new();
    static LAST: AtomicU64 = AtomicU64::new(0); // millis since BASE + 1 (0 = never)
    static LAST_LOG: AtomicU64 = AtomicU64::new(0);
    static ATTEMPTS: AtomicU64 = AtomicU64::new(0);
    let now = BASE.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64 + 1;
    let last = LAST.load(Ordering::SeqCst);
    if last != 0 && now.saturating_sub(last) < 1000 {
        return None;
    }
    LAST.store(now, Ordering::SeqCst);
    let attempt = ATTEMPTS.fetch_add(1, Ordering::SeqCst);
    let last_log = LAST_LOG.load(Ordering::SeqCst);
    let log_it = attempt < 3 || now.saturating_sub(last_log) >= 10_000;
    if log_it {
        LAST_LOG.store(now, Ordering::SeqCst);
    }
    Some(log_it)
}

/// Milliseconds the cursor must stay outside before the native monitor asks the frontend to collapse.
const COLLAPSE_AFTER_MS: u128 = 300;
/// While the collapse condition persists, re-emit at most this often (the frontend handler is idempotent).
const REEMIT_MS: u128 = 1000;

/// Pure hover decision: Some(true) = expand, Some(false) = collapse, None = nothing to do.
fn hover_decision(
    inside: bool,
    expanded: bool,
    pinned: bool,
    outside_ms: Option<u128>,
    since_last_emit_ms: Option<u128>,
) -> Option<bool> {
    if inside && !expanded {
        return Some(true);
    }
    if expanded && !pinned && !inside {
        let outside = outside_ms?;
        if outside >= COLLAPSE_AFTER_MS && since_last_emit_ms.map_or(true, |ms| ms >= REEMIT_MS) {
            return Some(false);
        }
    }
    None
}

fn mono_ms() -> u64 {
    static BASE: OnceLock<std::time::Instant> = OnceLock::new();
    BASE.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64 + 1
}

/// Millis since the last hover emit (None = never).
fn since_last_hover_emit() -> Option<u128> {
    let last = LAST_HOVER_EMIT.load(Ordering::SeqCst);
    (last != 0).then(|| mono_ms().saturating_sub(last) as u128)
}

static LAST_HOVER_EMIT: AtomicU64 = AtomicU64::new(0);
static LAST_KEEP_TOP: AtomicU64 = AtomicU64::new(0);

/// `keep_on_top` at most once per second.
fn keep_on_top_throttled(window: &WebviewWindow) {
    let now = mono_ms();
    let last = LAST_KEEP_TOP.load(Ordering::SeqCst);
    if last != 0 && now.saturating_sub(last) < 1000 {
        return;
    }
    LAST_KEEP_TOP.store(now, Ordering::SeqCst);
    keep_on_top(window);
}

/// Whether the cursor is inside the island's real OS rect (cached rect only as a fallback).
fn cursor_inside(app: &tauri::AppHandle, window: &WebviewWindow) -> Option<bool> {
    let cursor = app.cursor_position().ok()?;
    let rect = physical_rect(window).or_else(|| {
        app.state::<IslandRuntime>()
            .1
            .rect
            .lock()
            .ok()
            .and_then(|rect| *rect)
    })?;
    Some(contains(rect, cursor.x, cursor.y))
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
    if !active {
        return;
    }
    let inside = cursor_inside(app, &window);
    let visible = window.is_visible().unwrap_or(false);
    if fullscreen_suppressed() {
        // A game or full-screen video is in front: step aside (the request keeps waiting) and never touch
        // z-order. Never while the user is hovering the island or has it expanded/pinned.
        if !(inside == Some(true) || expanded || pinned) {
            if visible {
                FULLSCREEN_HIDDEN.store(true, Ordering::SeqCst);
                diagnostic(app, "hide (full-screen app)");
                let _ = set_visible_without_activation(&window, false);
            }
            return;
        }
    } else if FULLSCREEN_HIDDEN.swap(false, Ordering::SeqCst) && !visible {
        diagnostic(app, "show (full-screen app gone)");
        let _ = set_visible_without_activation(&window, true);
        return;
    }
    if needs_reshow(
        active,
        visible,
        FULLSCREEN_HIDDEN.load(Ordering::SeqCst),
        fullscreen_suppressed(),
    ) {
        // Active island whose OS window is hidden without us having asked (no "hide" in the log): the
        // user sees it vanish and no hover/layout can ever fire again. Show it again, at most once a second.
        if let Some(log_it) = reshow_due() {
            if log_it {
                diagnostic(
                    app,
                    &format!(
                        "self-heal show (hidden externally; expanded={expanded} pinned={pinned})"
                    ),
                );
            }
            if let Ok(mut state) = app.state::<IslandRuntime>().0.lock() {
                state.outside_since = None;
            }
            let _ = apply_bounds(&window, expanded, height);
            let _ = set_visible_without_activation(&window, true);
        }
        return;
    }
    if !visible {
        return;
    }
    keep_on_top_throttled(&window);
    if !pinned {
        // The native resize animation is no longer started (CSS owns the motion), so a non-zero `running`
        // can only be stale: never let it block re-applying the desired bounds.
        app.state::<IslandRuntime>().1.running.store(0, Ordering::SeqCst);
        let desired = bounds(&window, expanded, height);
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
    }
    let Some(inside) = inside else {
        return;
    };
    // Track how long the cursor has been outside an expanded island.
    let outside_since = if expanded && !inside {
        let since = outside_since.unwrap_or_else(std::time::Instant::now);
        if outside_since.is_none() {
            if let Ok(mut state) = app.state::<IslandRuntime>().0.lock() {
                state.outside_since = Some(since);
            }
        }
        Some(since)
    } else {
        if outside_since.is_some() {
            if let Ok(mut state) = app.state::<IslandRuntime>().0.lock() {
                state.outside_since = None;
            }
        }
        None
    };
    let outside_ms = outside_since.map(|since| since.elapsed().as_millis());
    if let Some(now_expanded) =
        hover_decision(inside, expanded, pinned, outside_ms, since_last_hover_emit())
    {
        diagnostic(app, &format!("hover expanded={now_expanded}"));
        LAST_HOVER_EMIT.store(mono_ms(), Ordering::SeqCst);
        // outside_since stays as is: the frontend ack (island_set_layout) clears it, and until then
        // the collapse is re-emitted at most once per REEMIT_MS.
        let _ = window.emit(
            "island:hover",
            serde_json::json!({"expanded": now_expanded}),
        );
    }
}

/// Lines per second the UI log bridge accepts (a render loop must not flood island.log).
const UI_LOG_PER_SECOND: u64 = 20;

fn ui_log_allowed() -> bool {
    static WINDOW_START: AtomicU64 = AtomicU64::new(0);
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let now = mono_ms();
    let start = WINDOW_START.load(Ordering::SeqCst);
    if start == 0 || now.saturating_sub(start) >= 1000 {
        WINDOW_START.store(now, Ordering::SeqCst);
        COUNT.store(1, Ordering::SeqCst);
        return true;
    }
    COUNT.fetch_add(1, Ordering::SeqCst) < UI_LOG_PER_SECOND
}

fn sanitize_ui_message(message: &str) -> String {
    message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(300)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Diagnostics from the island webview (DOM enter/leave, render errors). Messages only, never request text.
#[tauri::command]
pub fn island_log(window: WebviewWindow, message: String) -> Result<(), String> {
    allowed_caller(&window, "island")?;
    if !ui_log_allowed() {
        return Ok(());
    }
    diagnostic(
        window.app_handle(),
        &format!("ui {}", sanitize_ui_message(&message)),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        IslandState, active_snapshot, clamped_height, contains, corner_radius, ease_out,
        set_island_enabled, update_snapshot_state, hover_decision, sanitize_ui_message,
        watchdog_action, WatchdogAction,
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
    fn active_but_hidden_island_is_shown_again_unless_fullscreen_suppresses_it() {
        use super::needs_reshow;
        assert!(needs_reshow(true, false, false, false));
        assert!(!needs_reshow(true, true, false, false), "already visible");
        assert!(!needs_reshow(false, false, false, false), "inactive stays hidden");
        assert!(!needs_reshow(true, false, true, false), "full-screen hide is handled by its own path");
        assert!(!needs_reshow(true, false, false, true));
    }

    #[test]
    fn watchdog_waits_for_ack_then_reloads_then_recreates() {
        assert_eq!(watchdog_action(None, false, 0, None), WatchdogAction::None);
        assert_eq!(watchdog_action(Some(500), false, 0, None), WatchdogAction::None);
        assert_eq!(watchdog_action(Some(5000), true, 0, None), WatchdogAction::None);
        assert_eq!(watchdog_action(Some(1600), false, 0, None), WatchdogAction::Reload);
        assert_eq!(watchdog_action(Some(1600), false, 1, Some(11_000)), WatchdogAction::Recreate);
    }

    #[test]
    fn watchdog_never_recovers_faster_than_the_cooldown() {
        assert_eq!(watchdog_action(Some(3000), false, 1, Some(3000)), WatchdogAction::None);
        assert_eq!(watchdog_action(Some(3000), false, 0, Some(9_999)), WatchdogAction::None);
        assert_eq!(watchdog_action(Some(3000), false, 0, Some(10_000)), WatchdogAction::Reload);
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
        // Expanded corners are 34 logical px (Dynamic Island design, 92d8476); the test still held the older 26 px value.
        assert_eq!(corner_radius(300, 1.5, true), 51.0);
        assert_eq!(corner_radius(40, 2.0, true), 20.0);
    }

    #[test]
    fn clamps_island_height_to_supported_logical_range() {
        assert_eq!(clamped_height(20.0), 40.0);
        assert_eq!(clamped_height(900.0), 560.0);
        assert_eq!(clamped_height(f64::NAN), 40.0);
    }

    #[test]
    fn monitor_choice_prefers_cursor_then_foreground_then_primary() {
        use super::choose_monitor;
        // Left monitor has a negative origin; primary (index 1) sits at 0,0; a third one is above.
        let monitors = [(-1920, 0, 1920, 1080), (0, 0, 2560, 1440), (0, -1080, 1920, 1080)];
        assert_eq!(choose_monitor(&monitors, Some((-100.0, 500.0)), Some((100.0, 100.0)), Some(1)), Some(0));
        assert_eq!(choose_monitor(&monitors, Some((5.0, -5.0)), None, Some(1)), Some(2));
        // Cursor unavailable or off every monitor: the foreground window's monitor.
        assert_eq!(choose_monitor(&monitors, None, Some((-900.0, 300.0)), Some(1)), Some(0));
        assert_eq!(choose_monitor(&monitors, Some((9999.0, 9999.0)), Some((100.0, 100.0)), Some(0)), Some(1));
        // Nothing known: primary, then the first monitor.
        assert_eq!(choose_monitor(&monitors, None, None, Some(1)), Some(1));
        assert_eq!(choose_monitor(&monitors, None, None, None), Some(0));
        assert_eq!(choose_monitor(&monitors, None, None, Some(7)), Some(0));
        assert_eq!(choose_monitor(&[], Some((1.0, 1.0)), None, None), None);
        // Monitor edges: right/bottom edges belong to the neighbour.
        assert_eq!(choose_monitor(&monitors, Some((0.0, 0.0)), None, None), Some(1));
        assert_eq!(choose_monitor(&monitors, Some((-1.0, 0.0)), None, None), Some(0));
    }

    #[test]
    fn fullscreen_suppression_is_per_monitor() {
        use super::{suppresses, FullscreenOn};
        assert!(!suppresses(FullscreenOn::Nowhere, Some((0, 0))));
        assert!(suppresses(FullscreenOn::Anywhere, Some((0, 0))));
        assert!(suppresses(FullscreenOn::Monitor((0, 0)), Some((0, 0))));
        assert!(!suppresses(FullscreenOn::Monitor((0, 0)), Some((-1920, 0))), "a game on another monitor must not hide the island");
        assert!(suppresses(FullscreenOn::Monitor((0, 0)), None), "unknown target is conservative");
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
    #[test]
    fn hover_decision_expands_on_enter() {
        assert_eq!(hover_decision(true, false, false, None, None), Some(true));
        assert_eq!(hover_decision(true, true, false, None, None), None);
    }

    #[test]
    fn hover_decision_collapses_only_after_delay() {
        assert_eq!(hover_decision(false, true, false, Some(299), None), None);
        assert_eq!(hover_decision(false, true, false, None, None), None);
        assert_eq!(hover_decision(false, true, false, Some(300), None), Some(false));
        assert_eq!(hover_decision(true, true, false, Some(900), None), None);
    }

    #[test]
    fn hover_decision_never_collapses_while_pinned() {
        assert_eq!(hover_decision(false, true, true, Some(5000), None), None);
    }

    #[test]
    fn hover_decision_reemit_is_throttled_to_one_second() {
        assert_eq!(hover_decision(false, true, false, Some(2000), Some(999)), None);
        assert_eq!(hover_decision(false, true, false, Some(2000), Some(1000)), Some(false));
    }

    #[test]
    fn ui_log_messages_are_single_line_and_capped() {
        let cleaned = sanitize_ui_message(&format!("a\nb\r{}", "x".repeat(400)));
        assert!(!cleaned.contains('\n') && !cleaned.contains('\r'));
        assert!(cleaned.chars().count() <= 300);
    }
}
