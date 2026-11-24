// Root-level host for the browser egress relay: starts/stops the Rust relay from this machine's choice and the user's mode,
// follows its status, and shows a short "your connection is in use" toast with the kill switch when it starts
// (docs/design/browser-user-egress.md §3.3). The live indicator and details stay in the footer's Network item (network-egress.tsx).
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useClient } from "@/lib/runtime/store";
import { EGRESS_SETTINGS_EVENT, egressSupported, refreshEgressStatus, relayWanted, setEgressHere, setEgressStatus, startEgress, stopEgress, stopUsingMyConnection, useBrowserEgress, type EgressStatus } from "@/lib/browser-egress";
import type { BrowserEgressMode } from "@/lib/runtime/browser-types";

const MODE_POLL_MS = 20_000;
/** The start notice (a toast) shows only briefly when the browser starts using the connection; the footer's Network item stays live. */
export const EGRESS_NOTICE_MS = 6_000;

export function BrowserEgressRelay() {
  const supported = egressSupported();
  const client = useClient();
  const { here, policy, status, upSince } = useBrowserEgress();
  const [mode, setMode] = useState<BrowserEgressMode>("server");
  const clientRef = useRef(client);
  clientRef.current = client;

  // The mode is a runtime setting (the daemon must know it even when no app is connected). Poll so another computer's change shows up.
  useEffect(() => {
    if (!supported) return;
    let stopped = false;
    const load = () => client.settings().then((s) => { if (!stopped) setMode(s.agentBrowserEgress ?? "server"); }, () => undefined);
    void load();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, MODE_POLL_MS);
    const onChange = (event: Event) => { const next = (event as CustomEvent<BrowserEgressMode>).detail; if (next) setMode(next); else void load(); };
    window.addEventListener(EGRESS_SETTINGS_EVENT, onChange);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener(EGRESS_SETTINGS_EVENT, onChange); };
  }, [supported, client]);

  const wanted = supported && relayWanted(here, mode);
  const policyKey = `${policy.allowOtherPorts}:${policy.dailyCapBytes}`;
  useEffect(() => {
    if (!supported) return;
    if (!wanted || !client.token) { void stopEgress(); return; }
    void startEgress(client, policy).catch((error: Error) => setEgressStatus({ running: false, state: "error", error: error.message, streams: 0, bytesPerMin: 0, rttMs: null, usedToday: 0, dailyCap: policy.dailyCapBytes, machine: null }));
    return () => { void stopEgress(); }; // sign-out, token change or unmount: nothing may keep egressing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, wanted, client.token, client.baseUrl, policyKey]);

  useEffect(() => {
    if (!supported) return;
    let unlisten: Array<() => void> = [];
    let gone = false;
    void (async () => {
      const a = await listen<EgressStatus>("egress://status", (event) => setEgressStatus({ ...event.payload }));
      // Tray "Stop using my connection": switch the setting off everywhere, not just locally.
      const b = await listen("egress://killed", () => {
        setEgressHere(false);
        void clientRef.current.updateSettings({ agentBrowserEgress: "server" }).then(() => { setMode("server"); window.dispatchEvent(new CustomEvent(EGRESS_SETTINGS_EVENT, { detail: "server" })); }).catch(() => undefined);
        setEgressStatus(null);
      });
      if (gone) { a(); b(); } else unlisten = [a, b];
    })();
    void refreshEgressStatus();
    return () => { gone = true; unlisten.forEach((fn) => fn()); };
  }, [supported]);

  // One notice per "up" period, when the first connection goes through this computer: a normal toast at the top of the window
  // (never a floating pill over the content), with the kill switch. The footer's Network item keeps the live indicator.
  const active = supported && status?.state === "up" && status.streams > 0;
  const noticedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!active || upSince === null || noticedFor.current === upSince) return;
    noticedFor.current = upSince;
    toast("Agent browser is using your connection", {
      id: "egress-notice", duration: EGRESS_NOTICE_MS, description: "Details and the switch are in the footer's Network item.",
      action: { label: "Stop", onClick: () => { void stopUsingMyConnection(clientRef.current).catch(() => undefined); } },
    });
  }, [active, upSince]);

  return null;
}
