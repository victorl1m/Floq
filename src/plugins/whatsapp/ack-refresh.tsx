// Fallback for lost delivery acks: while a chat is open WAHA is asked, at most every 30 seconds, for the newest messages' state. The runtime does nothing
// (and asks WAHA nothing) when no message of ours from the last 24 hours is waiting for its read tick.
import { useEffect, useRef } from "react";
import { ACK_REFRESH_EVERY_MS, needsAckRefresh } from "@whatsapp-shared/acks";
import type { Message } from "@whatsapp-shared/chat";
import { useWa } from "./context";

export function useAckRefresh(chatId: string, messages: Message[] | null): void {
  const { api } = useWa();
  const latest = useRef(messages);
  latest.current = messages;
  const loaded = messages !== null;
  useEffect(() => {
    if (!chatId || !loaded) return;
    let busy = false;
    const run = () => {
      if (busy || (typeof document !== "undefined" && document.visibilityState === "hidden") || !needsAckRefresh(latest.current, Date.now())) return;
      busy = true;
      // The runtime announces what changed like it does for an ack webhook; an error here is not worth showing.
      api("/chats/acks/refresh", { method: "POST", body: { chatId } }).catch(() => undefined).finally(() => { busy = false; });
    };
    run();
    const timer = setInterval(run, ACK_REFRESH_EVERY_MS);
    return () => clearInterval(timer);
  }, [api, chatId, loaded]);
}
