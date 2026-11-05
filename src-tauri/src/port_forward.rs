//! Local half of port forwarding: listen on 127.0.0.1:<port> and relay each accepted TCP connection over a
//! WebSocket to the runtime's per-port tunnel (see runtime/src/ports.ts). The URL (with auth) comes from the UI.
use futures_util::{SinkExt, StreamExt};
use std::{collections::HashMap, sync::Mutex};
use tauri::async_runtime::{spawn, JoinHandle};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinSet,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Default)]
pub struct Forwards(Mutex<HashMap<u16, JoinHandle<()>>>);

async fn relay(mut local: TcpStream, url: String) {
    let Ok((ws, _)) = connect_async(url).await else { return };
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (mut local_rx, mut local_tx) = local.split();
    let up = async {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match local_rx.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_tx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = ws_tx.close().await;
    };
    let down = async {
        while let Some(Ok(message)) = ws_rx.next().await {
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
            connections.spawn(relay(socket, url.clone()));
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
