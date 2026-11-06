//! Local half of port forwarding: listen on 127.0.0.1:<port> and relay each accepted TCP connection over a
//! WebSocket to the runtime's per-port tunnel (see runtime/src/ports.ts). The URL (with auth) comes from the UI.
use futures_util::{SinkExt, StreamExt};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::async_runtime::{spawn, JoinHandle};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinSet,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Default)]
pub struct Forwards(Mutex<HashMap<u16, JoinHandle<()>>>);

/// Close a relayed connection that moved no data for this long (a browser tab left open, a stuck client).
const IDLE: Duration = Duration::from_secs(15 * 60);
/// A browser sends its request line at once; a client silent this long is raw TCP (server-first protocol).
const FIRST_BYTES_WAIT: Duration = Duration::from_millis(300);
const MAX_HEAD: usize = 16 * 1024;
const HTTP_METHODS: [&[u8]; 9] = [b"GET ", b"POST ", b"PUT ", b"DELETE ", b"HEAD ", b"OPTIONS ", b"PATCH ", b"CONNECT ", b"TRACE "];

fn is_http(head: &[u8]) -> bool {
    HTTP_METHODS.iter().any(|method| head.starts_with(method))
}

/// (host, port) of a Host header or an Origin authority, host lowercased; IPv6 literals keep their brackets.
fn split_host_port(authority: &str) -> (String, Option<u16>) {
    let authority = authority.trim().to_ascii_lowercase();
    let after_host = if authority.starts_with('[') { authority.find(']').map(|i| i + 1) } else { authority.find(':') }.unwrap_or(authority.len());
    let port = authority[after_host..].strip_prefix(':').and_then(|port| port.parse().ok());
    (authority[..after_host].to_string(), port)
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// Guard against web pages (also via DNS rebinding) reaching the agent's sandbox services through a forwarded port.
/// `head` is the first chunk of the connection. Anything that is not an HTTP request (raw TCP clients, databases,
/// SSH) is not a browser and passes. For HTTP the Host must be a loopback name, and an Origin (browsers send it on
/// cross-origin and WebSocket requests) must be the Floq app or the forwarded port itself.
fn head_allowed(head: &[u8], port: u16) -> bool {
    if !is_http(head) {
        return true;
    }
    let end = head.windows(4).position(|window| window == b"\r\n\r\n").unwrap_or(head.len());
    let text = String::from_utf8_lossy(&head[..end]);
    let (mut host, mut origin) = (None, None);
    for line in text.split("\r\n").skip(1) {
        if let Some((name, value)) = line.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "host" => host = Some(value.trim().to_string()),
                "origin" => origin = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }
    if let Some(host) = &host {
        if !is_loopback_host(&split_host_port(host).0) {
            return false;
        }
    }
    let Some(origin) = origin else { return true };
    if matches!(origin.as_str(), "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost") {
        return true;
    }
    let Some((scheme, authority)) = origin.split_once("://") else { return false };
    if scheme != "http" && scheme != "https" {
        return false;
    }
    let (origin_host, origin_port) = split_host_port(authority);
    is_loopback_host(&origin_host) && origin_port.unwrap_or(if scheme == "https" { 443 } else { 80 }) == port
}

/// Read the connection's first bytes (to the end of an HTTP head) so they can be vetted, then replayed upstream.
async fn read_head(local: &mut TcpStream) -> Vec<u8> {
    let mut head = Vec::new();
    let mut buf = vec![0u8; 4096];
    while head.len() < MAX_HEAD && !head.windows(4).any(|window| window == b"\r\n\r\n") {
        match tokio::time::timeout(FIRST_BYTES_WAIT, local.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => head.extend_from_slice(&buf[..n]),
            _ => break,
        }
        // Not HTTP (or too short to tell yet is fine: methods are decided on the first chunk): do not buffer further.
        if head.len() >= 8 && !is_http(&head) {
            break;
        }
    }
    head
}

async fn relay(mut local: TcpStream, url: String, port: u16) {
    let head = read_head(&mut local).await;
    if !head_allowed(&head, port) {
        let _ = local.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
        return;
    }
    let Ok((ws, _)) = connect_async(url).await else { return };
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (mut local_rx, mut local_tx) = local.split();
    let up = async {
        if !head.is_empty() && ws_tx.send(Message::Binary(head.into())).await.is_err() {
            return;
        }
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match tokio::time::timeout(IDLE, local_rx.read(&mut buf)).await {
                Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
                Ok(Ok(n)) => {
                    if ws_tx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = ws_tx.close().await;
    };
    let down = async {
        while let Ok(Some(Ok(message))) = tokio::time::timeout(IDLE, ws_rx.next()).await {
            match message {
                Message::Binary(data) => {
                    if local_tx.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = local_tx.shutdown().await;
    };
    // Either side finishing ends the connection.
    tokio::select! { _ = up => {}, _ = down => {} }
}

pub async fn port_forward_start(state: tauri::State<'_, Forwards>, port: u16, url: String) -> Result<(), String> {
    if port < 1024 && cfg!(unix) {
        return Err(format!("Port {port} is privileged and cannot be forwarded"));
    }
    if !url.starts_with("ws://") && !url.starts_with("wss://") {
        return Err("Invalid tunnel URL".into());
    }
    let old = state.0.lock().unwrap().remove(&port);
    if let Some(old) = old {
        old.abort();
        // Let the old listener release the port before rebinding.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| format!("Port {port} is not available on this computer ({error})"))?;
    let task = spawn(async move {
        let mut connections = JoinSet::new();
        // Dropping the JoinSet (when this task is aborted) tears down open connections.
        while let Ok((socket, _)) = listener.accept().await {
            connections.spawn(relay(socket, url.clone(), port));
            while connections.try_join_next().is_some() {}
        }
    });
    state.0.lock().unwrap().insert(port, task);
    Ok(())
}

pub fn port_forward_stop(state: tauri::State<'_, Forwards>, port: u16) {
    if let Some(task) = state.0.lock().unwrap().remove(&port) {
        task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::head_allowed;

    fn req(headers: &str) -> Vec<u8> {
        format!("GET / HTTP/1.1\r\n{headers}\r\n\r\n").into_bytes()
    }

    #[test]
    fn guards_browser_requests() {
        assert!(head_allowed(&req("Host: 127.0.0.1:9222"), 9222));
        assert!(head_allowed(&req("Host: localhost:9222\r\nOrigin: http://localhost:9222"), 9222));
        assert!(head_allowed(&req("Host: localhost:9222\r\nOrigin: tauri://localhost"), 9222));
        assert!(!head_allowed(&req("Host: evil.example:9222"), 9222));
        assert!(!head_allowed(&req("Host: 127.0.0.1:9222\r\nOrigin: https://evil.example"), 9222));
        assert!(!head_allowed(&req("Host: 127.0.0.1:9222\r\nOrigin: null"), 9222));
        assert!(!head_allowed(&req("Host: 127.0.0.1:9222\r\nOrigin: http://localhost:3000"), 9222));
        assert!(head_allowed(b"\x16\x03\x01raw tls or ssh", 22));
    }
}
