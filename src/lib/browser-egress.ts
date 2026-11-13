// Desktop-only store for "route the agent browser's traffic through this computer" (docs/design/browser-user-egress.md §4/§5.FE).
// The relay itself is Rust (src-tauri/src/egress.rs); this file holds the per-machine choice, the policy and the live status.
import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { BrowserEgress, BrowserEgressMode } from "@/lib/runtime/browser-types";

/** Fired on `window` (detail: the new mode) after the mode setting changed so the relay host reacts without waiting for its poll. */
export const EGRESS_SETTINGS_EVENT = "floq:browser-egress-settings";

/** The relay needs the desktop app: the connection to the runtime and the TCP sockets live in Rust. */
export const egressSupported = () => isTauri();

export interface EgressRecent { host: string; port: number; bytes: number; start: number; end: number; result: string }
/** Mirror of the Rust `Status` (egress://status) and, with `recent`, of `egress_status`. */
export interface EgressStatus {
  running: boolean;
  /** off | connecting | up | standby | paused | error */
  state: "off" | "connecting" | "up" | "standby" | "paused" | "error";
  error: string | null;
  streams: number;
  bytesPerMin: number;
  rttMs: number | null;
  usedToday: number;
  dailyCap: number;
  machine: string | null;
  recent?: EgressRecent[];
}
export interface EgressPolicy { allowOtherPorts: boolean; dailyCapBytes: number }

export const GIB = 1024 ** 3;
export const DEFAULT_POLICY: EgressPolicy = { allowOtherPorts: false, dailyCapBytes: 10 * GIB };
const HERE_KEY = "floq.browserEgress.here";
const POLICY_KEY = "floq.browserEgress.policy";

interface State { here: boolean; policy: EgressPolicy; status: EgressStatus | null }

function readLocal(): State {
  let here = false;
  let policy = DEFAULT_POLICY;
  try {
    here = localStorage.getItem(HERE_KEY) === "1";
    const raw = localStorage.getItem(POLICY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<EgressPolicy>;
      policy = {
        allowOtherPorts: parsed.allowOtherPorts === true,
        dailyCapBytes: typeof parsed.dailyCapBytes === "number" && parsed.dailyCapBytes > 0 ? parsed.dailyCapBytes : DEFAULT_POLICY.dailyCapBytes,
      };
    }
  } catch { /* storage unavailable: defaults (off) */ }
  return { here, policy, status: null };
}

let state: State = readLocal();
const listeners = new Set<() => void>();
function set(next: State) { state = next; listeners.forEach((l) => l()); }

export function useBrowserEgress(): State {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => state, () => state);
}

/** Whether THIS machine is the one egressing. Per machine, in local storage; the mode itself is a runtime setting. */
export function setEgressHere(here: boolean) {
  try { localStorage.setItem(HERE_KEY, here ? "1" : "0"); } catch { /* ignore */ }
  set({ ...state, here });
}
export function setEgressPolicy(policy: EgressPolicy) {
  try { localStorage.setItem(POLICY_KEY, JSON.stringify(policy)); } catch { /* ignore */ }
  set({ ...state, policy });
}
export function setEgressStatus(status: EgressStatus | null) {
  set({ ...state, status });
}

const message = (error: unknown) => (typeof error === "string" ? error : error instanceof Error ? error.message : "Could not start the connection relay");

export async function startEgress(client: RuntimeClient, policy: EgressPolicy): Promise<void> {
  if (!egressSupported()) throw new Error("Available in the desktop app");
  if (!client.token) throw new Error("Sign in first");
  try {
    await invoke("egress_start", { url: client.browserEgressUrl(), token: client.token, policy });
  } catch (error) { throw new Error(message(error)); }
}

/** The kill switch: closes the WebSocket and every stream at once. */
export async function stopEgress(): Promise<void> {
  if (egressSupported()) await invoke("egress_stop").catch(() => undefined);
  setEgressStatus(null);
}

export async function refreshEgressStatus(): Promise<EgressStatus | null> {
  if (!egressSupported()) return null;
  try {
    const status = await invoke<EgressStatus>("egress_status");
    setEgressStatus(status);
    return status;
  } catch { return null; }
}

/** Whether the relay should be running: this machine chose it AND the user's mode wants a desktop. */
export const relayWanted = (here: boolean, mode: BrowserEgressMode) => here && mode !== "server";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < GIB) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / GIB).toFixed(2)} GB`;
}

/** One line for Settings and the indicator. */
export function describeEgress(status: EgressStatus | null): string {
  if (!status || status.state === "off") return "Off on this computer";
  switch (status.state) {
    case "connecting": return status.error ? `Connecting… (${status.error})` : "Connecting to the server…";
    case "standby": return "Another computer of yours is being used";
    case "paused": return status.error ?? "Paused: limit reached";
    case "error": return status.error ?? "Could not connect";
    default: return status.streams > 0 ? `Agent browser is using your connection · ${status.streams} connection${status.streams === 1 ? "" : "s"}` : "Connected, idle";
  }
}

export interface EgressBadge { label: string; tone: "green" | "neutral" | "amber"; title: string; paused: boolean }
/** Browser node header badge (design §4.2). null while the runtime has not said anything (older runtimes: no badge). */
export function egressBadge(egress: BrowserEgress | null | undefined): EgressBadge | null {
  if (!egress) return null;
  const who = egress.machine ? egress.machine : "your computer";
  const rtt = typeof egress.rttMs === "number" ? ` · ${Math.round(egress.rttMs)} ms` : "";
  if (egress.override) return { label: "via server (this time)", tone: "amber", title: "Websites see Floq's server connection until your computer reconnects", paused: false };
  if (egress.mode === "server") return { label: "via server", tone: "neutral", title: "Websites see Floq's server connection", paused: false };
  if (egress.state === "up") return { label: "via your connection", tone: "green", title: `Websites see your connection, through ${who}${rtt}`, paused: false };
  if (egress.state === "standby") return { label: "via your connection", tone: "green", title: "Through another computer of yours", paused: false };
  if (egress.mode === "desktop-fallback") return { label: "via server (your computer is offline)", tone: "amber", title: "Floq isn't open on your computer, so the server's connection is used", paused: false };
  return { label: "paused", tone: "amber", title: "The browser uses your computer's connection and Floq isn't open there", paused: true };
}
