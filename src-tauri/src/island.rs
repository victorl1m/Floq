use serde_json::Value;
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow};

const COLLAPSED_WIDTH: f64 = 220.0;
const EXPANDED_WIDTH: f64 = 440.0;
const COLLAPSED_HEIGHT: f64 = 40.0;
const MAX_HEIGHT: f64 = 560.0;
const TOP_GAP: f64 = 12.0;

struct IslandState {
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
            active: false,
            expanded: false,
            pinned: false,
            height: COLLAPSED_HEIGHT,
            outside_since: None,
            last_non_empty_snapshot: None,
        }
    }
}

pub struct IslandRuntime(Mutex<IslandState>);

impl Default for IslandRuntime {
    fn default() -> Self {
        Self(Mutex::new(IslandState::default()))
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
    if snapshot.get("connected").and_then(Value::as_bool) == Some(false) {
        return false;
    }
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

fn apply_bounds(window: &WebviewWindow, expanded: bool, height: f64) -> Result<(), String> {
    let Some((x, y, width, height)) = bounds(window, expanded, height) else {
        return Err("No display is available for the island window".into());
    };
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
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
    let (active, expanded, height) = {
        let mut state = runtime.0.lock().map_err(|_| "Island state unavailable")?;
        let active = update_snapshot_state(&mut state, snapshot.clone(), enabled);
        (active, state.expanded, state.height)
    };
    let island = app
        .get_webview_window("island")
        .ok_or("Island window is unavailable")?;
    island
        .emit("island:snapshot", snapshot)
        .map_err(|error| error.to_string())?;
    if active {
        island
            .set_ignore_cursor_events(!expanded)
            .map_err(|error| error.to_string())?;
        apply_bounds(&island, expanded, height)?;
        island.show().map_err(|error| error.to_string())?;
    } else {
        island.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn set_enabled(
    app: &tauri::AppHandle,
    runtime: &IslandRuntime,
    enabled: bool,
) -> Result<(), String> {
    let (snapshot, expanded, height) = {
        let mut state = runtime.0.lock().map_err(|_| "Island state unavailable")?;
        let snapshot = set_island_enabled(&mut state, enabled);
        (snapshot, state.expanded, state.height)
    };
    let Some(window) = app.get_webview_window("island") else {
        return Ok(());
    };
    let Some(snapshot) = snapshot else {
        window.hide().map_err(|error| error.to_string())?;
        return Ok(());
    };
    window
        .emit("island:snapshot", snapshot)
        .map_err(|error| error.to_string())?;
    window
        .set_ignore_cursor_events(!expanded)
        .map_err(|error| error.to_string())?;
    apply_bounds(&window, expanded, height)?;
    window.show().map_err(|error| error.to_string())
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
) -> Result<(), String> {
    allowed_caller(&window, "island")?;
    let height = clamped_height(height);
    {
        let mut state = runtime.0.lock().map_err(|_| "Island state unavailable")?;
        state.expanded = expanded;
        state.pinned = pinned;
        state.height = height;
        state.outside_since = None;
    }
    window
        .set_ignore_cursor_events(!expanded)
        .map_err(|error| error.to_string())?;
    apply_bounds(&window, expanded, height)
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
    let _ = window.set_ignore_cursor_events(true);
    Ok(window)
}

pub fn start_hover_monitor(app: tauri::AppHandle) {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(75));
                let Some(window) = app.get_webview_window("island") else {
                    continue;
                };
                let state = app.state::<IslandRuntime>();
                let Ok(mut state) = state.0.lock() else {
                    continue;
                };
                if !state.active || state.pinned || !window.is_visible().unwrap_or(false) {
                    continue;
                }
                let desired = bounds(&window, state.expanded, state.height);
                if let (Some((x, y, width, height)), Ok(position), Ok(size)) =
                    (desired, window.outer_position(), window.outer_size())
                {
                    if position.x != x
                        || position.y != y
                        || size.width != width
                        || size.height != height
                    {
                        let _ = apply_bounds(&window, state.expanded, state.height);
                    }
                }
                let Ok(cursor) = app.cursor_position() else {
                    continue;
                };
                let inside =
                    physical_rect(&window).is_some_and(|rect| contains(rect, cursor.x, cursor.y));
                if inside && !state.expanded {
                    state.expanded = true;
                    state.outside_since = None;
                    let height = state.height;
                    drop(state);
                    let _ = window.set_ignore_cursor_events(false);
                    let _ = apply_bounds(&window, true, height);
                    let _ = window.emit("island:hover", serde_json::json!({"expanded": true}));
                } else if state.expanded && !inside {
                    let since = state
                        .outside_since
                        .get_or_insert_with(std::time::Instant::now);
                    if since.elapsed() >= std::time::Duration::from_millis(300) {
                        state.expanded = false;
                        state.outside_since = None;
                        let height = state.height;
                        drop(state);
                        let _ = window.set_ignore_cursor_events(true);
                        let _ = apply_bounds(&window, false, height);
                        let _ = window.emit("island:hover", serde_json::json!({"expanded": false}));
                    }
                } else if inside {
                    state.outside_since = None;
                }
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::{
        IslandState, active_snapshot, clamped_height, contains, set_island_enabled,
        update_snapshot_state,
    };
    use serde_json::json;

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
        assert!(!active_snapshot(
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
