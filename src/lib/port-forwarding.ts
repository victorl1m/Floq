import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { SessionPort } from "@/lib/runtime/types";

/** Forwarding needs the desktop app: the local listener lives in Rust (src-tauri/src/port_forward.rs). */
export const portForwardingSupported = isTauri();

interface State {
  /** Latest detected listening ports per session. */
  ports: Record<string, SessionPort[]>;
  /** Local port -> session it is forwarded from. The local port always equals the remote one (OAuth callbacks). */
  forwarded: Record<number, string>;
}

let state: State = { ports: {}, forwarded: {} };
const listeners = new Set<() => void>();

function set(next: State) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function usePortForwarding(): State {
  return useSyncExternalStore((callback) => { listeners.add(callback); return () => listeners.delete(callback); }, () => state, () => state);
}

export function setSessionPorts(sessionId: string, ports: SessionPort[]) {
  const current = state.ports[sessionId];
  if (current && current.length === ports.length && current.every((item, index) => item.port === ports[index].port && item.address === ports[index].address)) return;
  set({ ...state, ports: { ...state.ports, [sessionId]: ports } });
}

/** Throws with a readable message when the local port cannot be bound. */
export async function startForward(client: RuntimeClient, sessionId: string, port: number, manual = false): Promise<void> {
  if (!portForwardingSupported) throw new Error("Port forwarding is only available in the Floq desktop app.");
  try {
    await invoke("port_forward_start", { port, url: client.portTunnelUrl(sessionId, port, manual) });
  } catch (error) {
    throw new Error(typeof error === "string" ? error : error instanceof Error ? error.message : "Could not start forwarding");
  }
  set({ ...state, forwarded: { ...state.forwarded, [port]: sessionId } });
}

export async function stopForward(port: number): Promise<void> {
  if (portForwardingSupported) await invoke("port_forward_stop", { port }).catch(() => undefined);
  const { [port]: _removed, ...rest } = state.forwarded;
  set({ ...state, forwarded: rest });
}
