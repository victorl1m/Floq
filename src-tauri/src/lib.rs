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

/// Name a downloaded file safely: the server's Content-Disposition filename, reduced to one harmless path component.
fn download_file_name(disposition: Option<&str>, fallback: &str) -> String {
    fn percent_decode(input: &str) -> String {
        let bytes = input.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                let value = std::str::from_utf8(&bytes[i + 1..i + 3])
                    .ok()
                    .and_then(|hex| u8::from_str_radix(hex, 16).ok());
                if let Some(value) = value {
                    out.push(value);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }
    let mut raw: Option<String> = None;
    if let Some(header) = disposition {
        if let Some(index) = header.find("filename*=UTF-8''") {
            let rest = &header[index + "filename*=UTF-8''".len()..];
            let end = rest.find(';').unwrap_or(rest.len());
            raw = Some(percent_decode(rest[..end].trim()));
        } else if let Some(index) = header.find("filename=\"") {
            let rest = &header[index + "filename=\"".len()..];
            if let Some(end) = rest.find('"') {
                raw = Some(rest[..end].to_string());
            }
        }
    }
    let cleaned: String = raw
        .unwrap_or_else(|| fallback.to_string())
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c == ' ' || c.is_whitespace()).to_string();
    let upper = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&upper.as_str())
        || (upper.len() == 4 && (upper.starts_with("COM") || upper.starts_with("LPT")));
    if cleaned.is_empty() || reserved {
        "download".to_string()
    } else {
        cleaned.chars().take(180).collect()
    }
}

/// Parse `value` and require it to point at exactly the runtime's origin (scheme, host, port), without credentials.
fn same_origin_url(value: &str, origin: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid URL".to_string())?;
    let base = reqwest::Url::parse(origin).map_err(|_| "Invalid runtime address".to_string())?;
    let http = |u: &reqwest::Url| u.scheme() == "http" || u.scheme() == "https";
    if !http(&url) || !http(&base) || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("Invalid URL".into());
    }
    // Only plain DNS names or IP literals: no quotes, commas, ampersands etc. that could be misread by a shell, AppleScript or Explorer.
    let host_ok = |u: &reqwest::Url| match u.host_str() {
        // Bracketed IPv6 literal (the URL parser has already validated it).
        Some(host) if host.starts_with('[') => host.ends_with(']'),
        Some(host) => !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'),
        None => false,
    };
    if !host_ok(&url) || !host_ok(&base) {
        return Err("Invalid runtime address".into());
    }
    if url.scheme() != base.scheme() || url.host_str() != base.host_str() || url.port_or_known_default() != base.port_or_known_default() {
        return Err("This link does not point at your Floq runtime".into());
    }
    Ok(url)
}

/// `/v1/sessions/<id>/files/download` with nothing but a `t` query parameter.
fn valid_download_url(url: &reqwest::Url) -> bool {
    let parts: Vec<&str> = url.path().split('/').collect();
    let id_ok = |id: &str| !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    let path_ok = parts.len() == 6 && parts[0].is_empty() && parts[1] == "v1" && parts[2] == "sessions" && id_ok(parts[3]) && parts[4] == "files" && parts[5] == "download";
    let mut query = url.query_pairs();
    let first = query.next();
    path_ok && query.next().is_none() && matches!(first, Some((ref key, _)) if key == "t")
}

/// Stream a signed runtime download link into the user's Downloads folder (works the same on Windows, macOS and Linux webviews).
/// Only links on the runtime's own origin are fetched, redirects are refused, and the file name comes from the response.
/// Returns the saved path. Never overwrites: a taken name becomes "name (1).ext".
#[tauri::command]
async fn download_to_downloads(app: tauri::AppHandle, url: String, origin: String, fallback_name: String) -> Result<String, String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let parsed = same_origin_url(&url, &origin)?;
    if !valid_download_url(&parsed) {
        return Err("Invalid download URL".into());
    }
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not start the download".to_string())?
        .get(parsed)
        .send()
        .await
        .map_err(|_| "Runtime unreachable".to_string())?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|value| value.pointer("/error/message").and_then(|m| m.as_str()).map(str::to_string));
        return Err(message.unwrap_or_else(|| format!("Download failed ({status})")));
    }
    let disposition = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let name = download_file_name(disposition.as_deref(), &fallback_name);
    let dir = app
        .path()
        .download_dir()
        .map_err(|_| "Could not find your Downloads folder".to_string())?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| "Could not open your Downloads folder".to_string())?;

    let (stem, ext) = match name.rfind('.') {
        Some(index) if index > 0 => (name[..index].to_string(), name[index..].to_string()),
        _ => (name.clone(), String::new()),
    };
    let mut target = dir.join(&name);
    let mut part = dir.join(format!("{name}.part"));
    let mut file = None;
    for attempt in 0..1000 {
        if attempt > 0 {
            let candidate = format!("{stem} ({attempt}){ext}");
            target = dir.join(&candidate);
            part = dir.join(format!("{candidate}.part"));
        }
        if target.exists() {
            continue;
        }
        match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&part).await {
            Ok(handle) => {
                file = Some(handle);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("Could not write to your Downloads folder".into()),
        }
    }
    let mut file = file.ok_or_else(|| "Could not pick a file name in your Downloads folder".to_string())?;
    let mut stream = response.bytes_stream();
    let mut failed = false;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                if file.write_all(&bytes).await.is_err() {
                    failed = true;
                    break;
                }
            }
            Err(_) => {
                failed = true;
                break;
            }
        }
    }
    if !failed && file.flush().await.is_err() {
        failed = true;
    }
    drop(file);
    if failed {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("The download was interrupted".into());
    }
    tokio::fs::rename(&part, &target)
        .await
        .map_err(|_| "Could not finish saving the file".to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// `/dav/<32 lowercase hex>/` on the runtime origin: the read-only WebDAV share created by "Open in Explorer".
fn valid_dav_url(url: &reqwest::Url) -> bool {
    let parts: Vec<&str> = url.path().split('/').collect();
    parts.len() == 4
        && parts[0].is_empty()
        && parts[1] == "dav"
        && parts[2].len() == 32
        && parts[2].chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
        && parts[3].is_empty()
        && url.query().is_none()
}

/// Windows WebClient UNC form: \\host@SSL@port\DavWWWRoot\dav\<token> or \\host@port\... (no trailing backslash).
/// The port is ALWAYS explicit: without @SSL/@port Windows tries SMB (445) first and would send NTLM credentials to the host.
/// IPv6 literals are not valid UNC host names, so they are refused.
fn dav_unc(url: &reqwest::Url) -> Result<String, String> {
    let host = match url.host_str() {
        Some(host) if !host.starts_with('[') => host.to_string(),
        _ => return Err("Explorer cannot open a runtime addressed by an IPv6 literal. Use a host name, or use Download.".into()),
    };
    let port = url.port_or_known_default().ok_or_else(|| "Invalid share address".to_string())?;
    let token = url.path().split('/').nth(2).ok_or_else(|| "Invalid share address".to_string())?;
    let tls = if url.scheme() == "https" { "@SSL" } else { "" };
    Ok(format!("\\\\{host}{tls}@{port}\\DavWWWRoot\\dav\\{token}"))
}

#[cfg(windows)]
fn run_hidden(program: &str, args: &[&str]) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new(program)
        .args(args)
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|error| format!("Could not run {program}: {error}"))
}

/// The Windows WebDAV client is the WebClient service. Missing (Server SKUs) or disabled means Explorer cannot open the share.
#[cfg(windows)]
fn check_webclient() -> Result<(), String> {
    let query = run_hidden("sc.exe", &["query", "WebClient"])?;
    let text = String::from_utf8_lossy(&query.stdout).to_string();
    if !query.status.success() && text.contains("1060") {
        return Err("webclient_missing: Windows' WebDAV client (WebClient) is not installed on this PC. Use Download instead.".into());
    }
    let config = run_hidden("sc.exe", &["qc", "WebClient"])?;
    if String::from_utf8_lossy(&config.stdout).contains("DISABLED") {
        return Err("webclient_disabled: The Windows WebClient service is disabled. Enable it in Services (services.msc), then try again.".into());
    }
    Ok(())
}

/// Blocking part of "Open in Explorer"; run on a blocking thread so sc.exe / net.exe never stall the async runtime.
/// Arguments are always passed as argv items, never through a shell or script text.
fn open_dav_blocking(url: reqwest::Url, map_drive: bool) -> Result<String, String> {
    #[cfg(windows)]
    {
        let unc = dav_unc(&url)?;
        check_webclient()?;
        if map_drive {
            let output = run_hidden("net.exe", &["use", "*", &unc, "/persistent:no"])?;
            let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            if !output.status.success() {
                return Err(format!("webclient_unreachable: Windows could not connect to the share ({}). Check that the runtime uses HTTPS and the WebClient service is running.", text.trim().lines().next().unwrap_or("unknown error")));
            }
            return Ok(text.trim().lines().find(|line| line.contains(':')).unwrap_or("Connected").to_string());
        }
        std::process::Command::new("explorer.exe")
            .arg(format!("{unc}\\"))
            .spawn()
            .map_err(|error| format!("Could not start Explorer: {error}"))?;
        return Ok("Opened in Explorer".into());
    }
    #[cfg(target_os = "macos")]
    {
        let _ = map_drive;
        if url.host_str().is_some_and(|host| host.starts_with('[')) {
            return Err("Finder cannot open a runtime addressed by an IPv6 literal. Use a host name, or use Download.".into());
        }
        // The URL is an argument of the script (item 1 of argv), never part of the AppleScript source.
        let output = std::process::Command::new("osascript")
            .args(["-e", "on run argv", "-e", "mount volume (item 1 of argv)", "-e", "end run", "--", url.as_str()])
            .output()
            .map_err(|error| format!("Could not start Finder: {error}"))?;
        if !output.status.success() {
            return Err(format!("Finder could not connect: {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        return Ok("Mounted in Finder".into());
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let _ = map_drive;
        let scheme = if url.scheme() == "https" { "davs" } else { "dav" };
        let target = url.as_str().replacen(url.scheme(), scheme, 1);
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|error| format!("Could not open the file manager: {error}"))?;
        return Ok("Opened in the file manager".into());
    }
}

/// Open the project's read-only WebDAV share in the OS file manager. `map_drive` (Windows) maps the first free drive letter instead.
#[tauri::command]
async fn open_dav_mount(dav_url: String, origin: String, map_drive: bool) -> Result<String, String> {
    let url = same_origin_url(&dav_url, &origin)?;
    if !valid_dav_url(&url) {
        return Err("Invalid share address".into());
    }
    tauri::async_runtime::spawn_blocking(move || open_dav_blocking(url, map_drive))
        .await
        .map_err(|_| "The file manager request failed".to_string())?
}

/// Best-effort disconnect of a share mapped with `net use` (Windows). The server-side revoke is what actually ends access.
#[tauri::command]
async fn eject_dav_mount(dav_url: String, origin: String) -> Result<(), String> {
    let url = same_origin_url(&dav_url, &origin)?;
    if !valid_dav_url(&url) {
        return Err("Invalid share address".into());
    }
    #[cfg(windows)]
    {
        if let Ok(unc) = dav_unc(&url) {
            let _ = tauri::async_runtime::spawn_blocking(move || run_hidden("net.exe", &["use", &unc, "/delete", "/y"])).await;
        }
    }
    #[cfg(not(windows))]
    let _ = url;
    Ok(())
}

/// Material currently applied to the main window: "mica" | "acrylic" | "vibrancy" | "none".
struct NativeMaterial(Mutex<&'static str>);

impl Default for NativeMaterial {
    fn default() -> Self {
        Self(Mutex::new("none"))
    }
}

/// Windows build number via RtlGetVersion (None if the call fails).
#[cfg(windows)]
fn windows_build() -> Option<u32> {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    unsafe { RtlGetVersion(&mut info) }.is_ok().then_some(info.dwBuildNumber)
}

/// Native backdrops this OS can show. Decided before the window is built, because a
/// transparent window without a backdrop would show the desktop through it.
fn native_material_support_list() -> Vec<&'static str> {
    #[cfg(windows)]
    {
        return match windows_build() {
            Some(build) if build >= 22000 => vec!["mica", "acrylic"],
            Some(build) if build >= 17763 => vec!["acrylic"],
            _ => vec![],
        };
    }
    #[cfg(target_os = "macos")]
    {
        return vec!["vibrancy"];
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        vec![]
    }
}

/// Apply or clear the native backdrop on `window`; returns the resulting material.
fn apply_native_material(
    window: &tauri::WebviewWindow,
    material: &str,
    theme: Option<&str>,
) -> &'static str {
    use tauri::window::{Color, Effect, EffectState, EffectsBuilder};
    let supported = native_material_support_list();
    let wanted = supported.iter().copied().find(|m| *m == material);
    if supported.is_empty() {
        return "none";
    }
    let explicit = match theme {
        Some("light") => Some(tauri::Theme::Light),
        Some("dark") => Some(tauri::Theme::Dark),
        _ => None,
    };
    if let Err(error) = window.set_theme(explicit) {
        eprintln!("Failed to set window theme: {error}");
    }
    let Some(wanted) = wanted else {
        if let Err(error) = window.set_effects(None) {
            eprintln!("Failed to clear window effects: {error}");
        }
        return "none";
    };
    let builder = EffectsBuilder::new().state(EffectState::FollowsWindowActiveState);
    let builder = match wanted {
        "mica" => builder.effect(match explicit {
            Some(tauri::Theme::Light) => Effect::MicaLight,
            Some(tauri::Theme::Dark) => Effect::MicaDark,
            _ => Effect::Mica,
        }),
        "acrylic" => {
            let builder = builder.effect(Effect::Acrylic);
            match explicit {
                Some(tauri::Theme::Light) => builder.color(Color(243, 243, 243, 153)),
                Some(tauri::Theme::Dark) => builder.color(Color(32, 32, 32, 153)),
                _ => builder,
            }
        }
        _ => {
            #[cfg(target_os = "macos")]
            let effect = Effect::UnderWindowBackground;
            #[cfg(not(target_os = "macos"))]
            let effect = Effect::Mica;
            builder.effect(effect)
        }
    };
    match window.set_effects(builder.build()) {
        Ok(()) => wanted,
        Err(error) => {
            eprintln!("Failed to apply window effect: {error}");
            "none"
        }
    }
}

#[tauri::command]
fn native_material_support() -> Vec<String> {
    native_material_support_list().into_iter().map(String::from).collect()
}

#[tauri::command]
fn native_material(state: tauri::State<'_, NativeMaterial>) -> String {
    state.0.lock().map(|m| (*m).to_string()).unwrap_or_else(|_| "none".into())
}

#[tauri::command]
fn set_native_material(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeMaterial>,
    material: String,
    theme: Option<String>,
) -> String {
    let Some(window) = app.get_webview_window("main") else {
        return "none".into();
    };
    let applied = apply_native_material(&window, &material, theme.as_deref());
    if let Ok(mut current) = state.0.lock() {
        *current = applied;
    }
    applied.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .manage(port_forward::Forwards::default())
        .manage(Uploads::default())
        .manage(NativeMaterial::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_memory_details,
            inspect_dropped_file,
            upload_dropped_file,
            cancel_dropped_upload,
            download_to_downloads,
            open_dav_mount,
            eject_dav_mount,
            native_material_support,
            native_material,
            set_native_material,
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
                    // Transparent only where a native backdrop is available (Win10 1809+, Win11, macOS).
                    #[cfg(any(windows, target_os = "macos"))]
                    let builder = if !native_material_support_list().is_empty() {
                        builder
                            .transparent(true)
                            .background_color(tauri::window::Color(0, 0, 0, 0))
                    } else {
                        builder
                    };
                    // Debug WebView2 options can conflict with a running release
                    // instance when both use the same browser profile.
                    #[cfg(all(windows, debug_assertions))]
                    let builder = builder
                        .data_directory(app.path().app_local_data_dir()?.join("WebView2-dev"));
                    let window = builder.build()?;
                    if let Err(error) = window.set_shadow(true) {
                        eprintln!("Failed to enable window shadow: {error}");
                    }
                    {
                        // Default: mica on Win11, vibrancy on macOS, none on Win10; the frontend re-applies on load.
                        let support = native_material_support_list();
                        let default = if support.contains(&"mica") { "mica" } else { support.first().copied().filter(|m| *m == "vibrancy").unwrap_or("none") };
                        let material = apply_native_material(&window, default, None);
                        if let Ok(mut current) = app.state::<NativeMaterial>().0.lock() {
                            *current = material;
                        }
                    }
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
