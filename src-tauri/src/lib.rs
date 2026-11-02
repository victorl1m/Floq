use serde::Serialize;
use sysinfo::{MemoryRefreshKind, Pid, ProcessRefreshKind, RefreshKind, System};
use tauri::Manager;
#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
#[cfg(windows)]
use windows::core::Interface;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessMemory {
    pid: u32,
    name: String,
    memory: u64,
    is_main: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryDetails {
    total: u64,
    system_total: u64,
    system_used: u64,
    processes: Vec<ProcessMemory>,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

fn collect_process_tree(system: &System, root: Pid) -> Vec<ProcessMemory> {
    let mut processes = Vec::new();
    let mut stack = vec![root];

    while let Some(pid) = stack.pop() {
        if let Some(process) = system.process(pid) {
            let name = process.name().to_string_lossy();

            processes.push(ProcessMemory {
                pid: pid.as_u32(),
                name: if name.is_empty() {
                    "Unknown".to_string()
                } else {
                    name.into_owned()
                },
                memory: process.memory(),
                is_main: pid == root,
            });
        }

        stack.extend(
            system
                .processes()
                .iter()
                .filter(|(_, process)| process.parent() == Some(pid))
                .map(|(child_pid, _)| *child_pid),
        );
    }

    processes.sort_by(|a, b| b.memory.cmp(&a.memory));
    processes
}

#[tauri::command]
fn get_memory_details() -> MemoryDetails {
    let Ok(system) = System::new_with_specifics(
        RefreshKind::nothing()
            .with_memory(MemoryRefreshKind::nothing().with_ram())
            .with_processes(ProcessRefreshKind::nothing().with_memory()),
    ) else {
        return MemoryDetails {
            total: 0,
            system_total: 0,
            system_used: 0,
            processes: Vec::new(),
        };
    };

    let root = Pid::from_u32(std::process::id());
    let processes = collect_process_tree(&system, root);
    let total = processes.iter().map(|process| process.memory).sum();

    MemoryDetails {
        total,
        system_total: system.total_memory(),
        system_used: system.used_memory(),
        processes,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![greet, get_memory_details])
        .setup(|app| {
            // Handle window creation here: Tauri panics if an automatically
            // created window fails during the native event-loop callback.
            let result = (|| -> tauri::Result<()> {
                for config in &app.config().app.windows {
                    let builder = tauri::WebviewWindowBuilder::from_config(app, config)?
                        .general_autofill_enabled(false);
                    // Debug WebView2 options can conflict with a running release
                    // instance when both use the same browser profile.
                    #[cfg(all(windows, debug_assertions))]
                    let builder = builder
                        .data_directory(app.path().app_local_data_dir()?.join("WebView2-dev"));
                    let window = builder.build()?;
                    #[cfg(windows)]
                    window.with_webview(|webview| unsafe {
                        let result = webview
                            .controller()
                            .CoreWebView2()
                            .and_then(|core| core.Settings())
                            .and_then(|settings| settings.cast::<ICoreWebView2Settings4>())
                            .and_then(|settings| settings.SetIsPasswordAutosaveEnabled(false));
                        if let Err(error) = result {
                            eprintln!("Failed to disable WebView2 password autosave: {error}");
                        }
                    })?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                eprintln!("Failed to create Floq window: {error}");
                app.handle().exit(1);
            }
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("Failed to start Floq: {error}");
        std::process::exit(1);
    }
}
