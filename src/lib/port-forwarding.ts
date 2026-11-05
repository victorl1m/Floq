import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { SessionDebugLink, SessionPort } from "@/lib/runtime/types";

/** Forwarding needs the desktop app: the local listener lives in Rust (src-tauri/src/port_forward.rs). */
export const portForwardingSupported = isTauri();

interface State {
  /** Latest detected listening ports per session. */
  ports: Record<string, SessionPort[]>;
  /** Local port -> session it is forwarded from. The local port always equals the remote one (OAuth callbacks). */
  forwarded: Record<number, string>;
  /** App preview / DevTools links per session (runtime only returns those whose ports are listening). */
  links: Record<string, SessionDebugLink[]>;
}

let state: State = { ports: {}, forwarded: {}, links: {} };
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

export function setSessionLinks(sessionId: string, links: SessionDebugLink[]) {
  const current = state.links[sessionId];
  if (current && current.length === links.length && current.every((item, index) => item.url === links[index].url)) return;
  set({ ...state, links: { ...state.links, [sessionId]: links } });
}

/**
 * The link's URL on the local forward: always http(s)://127.0.0.1:<port><path+query>, since the forward listens on IPv4
 * loopback only and "localhost" may resolve to ::1. Never trusts the printed host.
 */
export function localLinkUrl(link: SessionDebugLink): string {
  try {
    const url = new URL(link.url);
    const scheme = url.protocol === "https:" ? "https:" : "http:";
    return `${scheme}//127.0.0.1:${link.port}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return `http://127.0.0.1:${link.port}/`;
  }
}

/** Forward every port a link needs (local port == remote port), then open it in the default browser. */
export async function openDebugLink(client: RuntimeClient, sessionId: string, link: SessionDebugLink): Promise<void> {
  for (const port of [link.port, ...(link.extraPorts ?? [])]) {
    if (state.forwarded[port] !== sessionId) await startForward(client, sessionId, port);
  }
  await openUrl(localLinkUrl(link));
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
