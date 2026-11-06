use serde::{Deserialize, Serialize};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
#[cfg(windows)]
use tauri::menu::CheckMenuItem;
use tauri::{
    Manager, WebviewWindow,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub keep_running_in_background: bool,
    pub island_enabled: bool,
    pub launch_at_login: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            keep_running_in_background: true,
            island_enabled: true,
            launch_at_login: false,
        }
    }
}

#[derive(Default)]
pub struct DesktopState {
    pub(crate) preferences: Mutex<Preferences>,
    tray_ready: AtomicBool,
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("desktop-preferences.json"))
}

fn load_preferences(app: &tauri::AppHandle) -> Preferences {
    settings_path(app)
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default()
}

fn persist_preferences(app: &tauri::AppHandle, preferences: &Preferences) -> Result<(), String> {
    let path = settings_path(app)?;
    let temp = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(preferences).map_err(|error| error.to_string())?;
    std::fs::write(&temp, data).map_err(|error| error.to_string())?;
    std::fs::rename(temp, path).map_err(|error| error.to_string())
}

fn toggle_island_preference(preferences: &mut Preferences) -> bool {
    preferences.island_enabled = !preferences.island_enabled;
    preferences.island_enabled
}

fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("This command is only available to the main window".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{Preferences, toggle_island_preference};

    #[test]
    fn tray_toggle_updates_the_island_preference_value() {
        let mut preferences = Preferences::default();
        assert!(!toggle_island_preference(&mut preferences));
        assert!(!preferences.island_enabled);
        assert!(toggle_island_preference(&mut preferences));
        assert!(preferences.island_enabled);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesView {
    pub keep_running_in_background: bool,
    pub island_enabled: bool,
    pub launch_at_login: bool,
    pub tray_available: bool,
    pub windows_controls_available: bool,
}

fn preferences_view(state: &DesktopState, preferences: &Preferences) -> PreferencesView {
    PreferencesView {
        keep_running_in_background: preferences.keep_running_in_background,
        island_enabled: preferences.island_enabled,
        launch_at_login: preferences.launch_at_login,
        tray_available: state.tray_ready.load(Ordering::Relaxed),
        windows_controls_available: cfg!(windows),
    }
}

fn notify_main_preferences(app: &tauri::AppHandle, preferences: &PreferencesView) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let Ok(detail) = serde_json::to_string(preferences) else {
        return;
    };
    let script = format!(
        "window.dispatchEvent(new CustomEvent('floq:desktop-preferences', {{ detail: {detail} }}));"
    );
    if let Err(error) = main.eval(&script) {
        eprintln!("Could not notify the main window about desktop preferences: {error}");
    }
}

fn toggle_island_from_tray(app: &tauri::AppHandle) {
    let desktop = app.state::<DesktopState>();
    let (enabled, view) = {
        let Ok(mut current) = desktop.preferences.lock() else {
            eprintln!("Desktop preferences are unavailable");
            return;
        };
        let enabled = toggle_island_preference(&mut current);
        if let Err(error) = persist_preferences(app, &current) {
            current.island_enabled = !enabled;
            eprintln!("Could not save island preference: {error}");
            return;
        }
        let view = preferences_view(&desktop, &current);
        (enabled, view)
    };

    if let Err(error) =
        crate::island::set_enabled(app, &app.state::<crate::island::IslandRuntime>(), enabled)
    {
        eprintln!("Could not update island visibility: {error}");
    }
    notify_main_preferences(app, &view);
}

#[tauri::command]
pub fn get_desktop_preferences(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<PreferencesView, String> {
    main_only(&window)?;
    let mut preferences = state
        .preferences
        .lock()
        .map_err(|_| "Preferences unavailable")?
        .clone();
    #[cfg(windows)]
    {
        use tauri_plugin_autostart::ManagerExt;
        preferences.launch_at_login = app
            .autolaunch()
            .is_enabled()
            .map_err(|error| error.to_string())?;
    }
    Ok(preferences_view(&state, &preferences))
}

#[tauri::command]
pub fn set_desktop_preference(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    preference: String,
    enabled: bool,
) -> Result<PreferencesView, String> {
    main_only(&window)?;
    let mut preferences = state
        .preferences
        .lock()
        .map_err(|_| "Preferences unavailable")?;
    let mut island_enabled_change = None;
    match preference.as_str() {
        "keepRunningInBackground" => preferences.keep_running_in_background = enabled,
        "islandEnabled" => {
            preferences.island_enabled = enabled;
            island_enabled_change = Some(enabled);
        }
        "launchAtLogin" => {
            #[cfg(windows)]
            {
                use tauri_plugin_autostart::ManagerExt;
                let manager = app.autolaunch();
                if enabled {
                    manager.enable().map_err(|error| error.to_string())?;
                } else {
                    manager.disable().map_err(|error| error.to_string())?;
                }
                preferences.launch_at_login =
                    manager.is_enabled().map_err(|error| error.to_string())?;
                if preferences.launch_at_login != enabled {
                    return Err("Windows did not apply the startup preference".into());
                }
            }
            #[cfg(not(windows))]
            return Err("Start with Windows is only available on Windows".into());
        }
        _ => return Err("Unknown desktop preference".into()),
    }
    persist_preferences(&app, &preferences)?;
    let view = preferences_view(&state, &preferences);
    drop(preferences);
    if let Some(enabled) = island_enabled_change {
        crate::island::set_enabled(&app, &app.state::<crate::island::IslandRuntime>(), enabled)?;
    }
    Ok(view)
}

pub fn is_background_launch() -> bool {
    std::env::args().any(|arg| arg == "--background")
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    *state
        .preferences
        .lock()
        .map_err(|_| "Preferences unavailable")? = load_preferences(app);
    let mut preferences = state
        .preferences
        .lock()
        .map_err(|_| "Preferences unavailable")?
        .clone();
    #[cfg(windows)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        if preferences.launch_at_login && !manager.is_enabled().unwrap_or(false) {
            if let Err(error) = manager.enable() {
                eprintln!("Could not restore Windows startup registration: {error}");
            }
        }
        preferences.launch_at_login = manager.is_enabled().map_err(|error| error.to_string())?;
        if let Ok(mut stored) = state.preferences.lock() {
            *stored = preferences.clone();
        }
    }

    let open = MenuItem::with_id(app, "open", "Open Floq", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let island = MenuItem::with_id(app, "island", "Show / Hide island", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let startup = CheckMenuItem::with_id(
        app,
        "startup",
        "Start with Windows",
        true,
        preferences.launch_at_login,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let quit =
        MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let menu =
        Menu::with_items(app, &[&open, &island, &startup, &quit]).map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    let menu = Menu::with_items(app, &[&open, &island, &quit]).map_err(|e| e.to_string())?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("No app icon is available for the tray")?;
    #[cfg(windows)]
    let startup_item = startup.clone();
    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        // Left click or double click on the tray icon brings Floq back (the menu stays on right click).
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            }
            | TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => show_main(tray.app_handle()),
            _ => {}
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "island" => toggle_island_from_tray(app),
            #[cfg(windows)]
            "startup" => {
                use tauri_plugin_autostart::ManagerExt;
                let manager = app.autolaunch();
                let desired = !manager.is_enabled().unwrap_or(false);
                let result = if desired {
                    manager.enable()
                } else {
                    manager.disable()
                };
                let actual = manager.is_enabled().unwrap_or(false);
                let _ = startup_item.set_checked(actual);
                if result.is_err() || actual != desired {
                    eprintln!("Could not update Windows startup registration");
                } else if let Ok(mut preferences) = app.state::<DesktopState>().preferences.lock() {
                    preferences.launch_at_login = actual;
                    let _ = persist_preferences(app, &preferences);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)
        .map_err(|error| error.to_string())?;

    state.tray_ready.store(true, Ordering::Relaxed);
    if let Some(main) = app.get_webview_window("main") {
        let app_handle = app.clone();
        main.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = app_handle.state::<DesktopState>();
                let should_hide = state.tray_ready.load(Ordering::Relaxed)
                    && state
                        .preferences
                        .lock()
                        .map(|p| p.keep_running_in_background)
                        .unwrap_or(false);
                if should_hide {
                    api.prevent_close();
                    if let Some(main) = app_handle.get_webview_window("main") {
                        let _ = main.hide();
                    }
                }
            }
        });
        if is_background_launch() {
            let _ = main.hide();
        }
    }
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
