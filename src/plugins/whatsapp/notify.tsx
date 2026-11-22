// The UI side of WhatsApp in Floq's island: tells the runtime which chat is on screen (no notification for the chat being read), opens the chat a
// notification points at, and the per-account switch in the account menu.
import { useEffect, useRef, useState } from "react";
import * as hostSdk from "@/plugins/sdk";
import { DropdownMenuItem, toast } from "@/plugins/kit";
import { errorText, type Api } from "./context";
import { IconBell, IconBellOff } from "./icons-session";

/** Repeated while a chat stays on screen; the runtime forgets a report after 45 s. */
const FOCUS_EVERY_MS = 20_000;
const onScreen = () => typeof document === "undefined" || (document.visibilityState === "visible" && (typeof document.hasFocus !== "function" || document.hasFocus()));

/** Reports the chat on screen (and "none" when the window is hidden, loses focus or the inbox closes). */
export function useNotifyFocus(api: Api, chatId: string): void {
  useEffect(() => {
    let last: string | null | undefined;
    const report = (force = false) => {
      const now = chatId && onScreen() ? chatId : null;
      if (!force && now === last && now === null) return;
      last = now;
      void api("/notify/focus", { method: "POST", body: { chatId: now } }).catch(() => undefined);
    };
    report(true);
    const timer = setInterval(() => report(true), FOCUS_EVERY_MS);
    const change = () => report();
    document.addEventListener("visibilitychange", change);
    window.addEventListener("focus", change);
    window.addEventListener("blur", change);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", change);
      window.removeEventListener("focus", change);
      window.removeEventListener("blur", change);
      if (last) void api("/notify/focus", { method: "POST", body: { chatId: null } }).catch(() => undefined);
    };
  }, [api, chatId]);
}

type OpenHook = (pluginId: string, viewId: string, callback: (params: Record<string, string>) => void) => void;
/** "Open chat" of a notification: the host hands the view `{ chat, session }`. A Floq without this hook just opens the inbox. */
export const useOpenFromHost: OpenHook = (hostSdk as unknown as { usePluginOpen?: OpenHook }).usePluginOpen ?? (() => undefined);

/** Account menu: notifications of this account in Floq's island, on or off. Hidden on a Floq that has no island notifications for plugins. */
export function NotifyMenuItem({ api }: { api: Api }) {
  const [state, setState] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void api<{ supported: boolean; enabled: boolean }>("/notify/settings").then((s) => { if (alive.current) setState(s); }).catch(() => undefined);
    return () => { alive.current = false; };
  }, [api]);
  if (!state?.supported) return null;
  const toggle = async () => {
    const next = !state.enabled;
    setState({ ...state, enabled: next });
    try { await api("/notify/settings", { method: "POST", body: { enabled: next } }); toast.success(next ? "Notifications on for this account" : "Notifications off for this account"); }
    catch (e) { if (alive.current) setState(state); toast.error("Could not change notifications", { description: errorText(e) }); }
  };
  return <DropdownMenuItem onSelect={() => void toggle()}>{state.enabled ? <IconBell /> : <IconBellOff />}{state.enabled ? "Notifications: On" : "Notifications: Off"}</DropdownMenuItem>;
}
