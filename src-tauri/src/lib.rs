mod port_forward;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
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

/// Safety cap for one dropped file; keep in sync with the runtime's FLOQ_MAX_UPLOAD_BYTES default.
const MAX_UPLOAD_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Cancel flags for in-flight dropped-file uploads, keyed by the renderer's upload id.
#[derive(Default)]
struct Uploads(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DroppedFileInfo {
    name: String,
    size: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UploadProgress {
    id: String,
    loaded: u64,
    total: u64,
}

/// Validate a dropped path (regular, non-empty, within the safety cap) without reading it.
#[tauri::command]
fn inspect_dropped_file(path: String) -> Result<DroppedFileInfo, String> {
    let file_path = Path::new(&path);
    let name = file_path
        .file_name()
        .and_then(|part| part.to_str())
        .ok_or("This file has no usable name")?
        .to_string();
    let metadata = std::fs::metadata(file_path).map_err(|_| "Could not read this file".to_string())?;
    if !metadata.is_file() {
        return Err("Only regular files can be uploaded (not folders)".into());
    }
    if metadata.len() == 0 {
        return Err("This file is empty".into());
    }
    if metadata.len() > MAX_UPLOAD_BYTES {
        return Err("This file is larger than the 8 GiB upload limit".into());
    }
    Ok(DroppedFileInfo { name, size: metadata.len() })
}

/// Stream a dropped file from disk to the runtime's attachment endpoint (PUT, raw body) without
/// loading it into memory, emitting `floq-upload-progress` events. Returns the response body.
#[tauri::command]
async fn upload_dropped_file(
    app: tauri::AppHandle,
    uploads: tauri::State<'_, Uploads>,
    upload_id: String,
    url: String,
    token: Option<String>,
    path: String,
) -> Result<String, String> {
    use futures_util::stream;
    use tauri::Emitter;
    use tokio::io::AsyncReadExt;

    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Invalid upload URL".into());
    }
    let info = inspect_dropped_file(path.clone())?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| "Could not read this file".to_string())?;
    let cancelled = Arc::new(AtomicBool::new(false));
    uploads
        .0
        .lock()
        .map_err(|_| "Upload state unavailable".to_string())?
        .insert(upload_id.clone(), cancelled.clone());

    let total = info.size;
    let flag = cancelled.clone();
    let id = upload_id.clone();
    let progress_app = app.clone();
    let body_stream = stream::unfold((file, 0_u64), move |(mut state, sent)| {
        let flag = flag.clone();
        let id = id.clone();
        let app = progress_app.clone();
        async move {
            if flag.load(Ordering::Relaxed) {
                return Some((Err(std::io::Error::other("cancelled")), (state, sent)));
            }
            let mut buffer = vec![0_u8; 256 * 1024];
            match state.read(&mut buffer).await {
                Ok(0) => {
                    if sent != total {
                        return Some((Err(std::io::Error::other("File changed while it was being read")), (state, sent)));
                    }
                    None
                }
                Ok(read) => {
                    buffer.truncate(read);
                    let loaded = sent + read as u64;
                    if loaded > total {
                        return Some((Err(std::io::Error::other("File changed while it was being read")), (state, loaded)));
                    }
                    let _ = app.emit("floq-upload-progress", UploadProgress { id, loaded, total });
                    Some((Ok(buffer), (state, loaded)))
                }
                Err(error) => Some((Err(error), (state, sent))),
            }
        }
    });

    let mut request = reqwest::Client::new()
        .put(&url)
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", total)
        .body(reqwest::Body::wrap_stream(body_stream));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let result = request.send().await;
    if let Ok(mut map) = uploads.0.lock() {
        map.remove(&upload_id);
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err("Upload cancelled".into());
    }
    let response = result.map_err(|_| "Runtime unreachable or the connection dropped during upload".to_string())?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        Ok(text)
    } else {
        // Surface the runtime's JSON error message when present.
        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|value| value.pointer("/error/message").and_then(|m| m.as_str()).map(str::to_string));
        Err(message.unwrap_or_else(|| {
            if status.as_u16() == 413 {
                "File is too large for the server or its proxy".to_string()
            } else {
                format!("Upload failed ({status})")
            }
        }))
    }
}

/// Abort an in-flight dropped-file upload; the runtime removes the partial file when the connection closes.
#[tauri::command]
fn cancel_dropped_upload(uploads: tauri::State<'_, Uploads>, upload_id: String) {
    if let Ok(map) = uploads.0.lock() {
        if let Some(flag) = map.get(&upload_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .manage(port_forward::Forwards::default())
        .manage(Uploads::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_memory_details,
            inspect_dropped_file,
            upload_dropped_file,
            cancel_dropped_upload,
            port_forward::port_forward_start,
            port_forward::port_forward_stop
        ])
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
