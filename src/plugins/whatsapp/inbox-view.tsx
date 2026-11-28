import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PluginPage, PluginState, toast, usePluginApi, usePluginEvent } from "@/plugins/kit";
import type { PluginViewProps } from "@/plugins/sdk";
import { quoteOf, type Chat, type Message, type MessageType, type Quote } from "@whatsapp-shared/chat";
import { featuresOf, type Engine, type Features } from "@whatsapp-shared/features";
import { useAvatarUrl } from "./avatars";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/plugins/kit";
import { ChatList } from "./chat-list";
import { ChatMenu } from "./chat-menu";
import { InfoPanel } from "./info-panel";
import { NewChatDialog } from "./new-chat";
import { IconNewChat } from "./icons-people";
import { IconMegaphone, IconStatus } from "./icons-more";
import { CallBanner } from "./call-banner";
import { ChannelsView } from "./channels-view";
import { LabelChips, LabelFilter, LabelPicker } from "./labels";
import { PresenceLine } from "./presence";
import { StatusView } from "./status-view";
import { AccountMenu, SessionBanner } from "./session-banner";
import { SessionScreen, useSessionInfo } from "./session-screen";
import { ContactsView } from "./contacts-view";
import { HistoryBar } from "./history";
import { IconArrowLeft } from "./icons";
import { subtitle } from "@whatsapp-shared/chat";
import { kindOfFile, mentionsIn, type Attachment } from "./composer";
import { WaContext, accountName, errorCode, errorStatus, errorText, scopedApi, type Account, type Api, type Wa } from "./context";
import { useNotifyFocus, useOpenFromHost } from "./notify";
import { AccountsContext, AddAccountDialog, accountHue, useAccountList, type Accounts } from "./accounts";
import { IconUserPlus } from "./icons-people";
import type { CSSProperties } from "react";
import { Conversation, EmptyConversation, type ConversationHandlers } from "./conversation";
import { CSS } from "./styles";
import { SESSION_CSS } from "./styles-session";

interface Status { configured: boolean; missingSettings: string[]; missingSecrets: string[]; session: string; engine?: Engine; features?: Features; me?: { name: string; phone: string | null } | null }
type Phase = { kind: "loading" } | { kind: "error"; message: string } | { kind: "forbidden" } | { kind: "ready"; status: Status };
/** A message being sent from this screen: shown at once. When the send returns, the stored message takes its row (same key, same node) and this entry goes.
 *  known: the ids in the log when it was sent, so a message that arrives before the send returns can be told apart from older ones. */
interface Pending { chatId: string; message: Message; serverId?: string; known: Set<string>; retry: () => void }
const sameContent = (a: Message, b: Message) => a.body === b.body && (a.type ?? "chat") === (b.type ?? "chat");

/** The log to show: stored messages (the ones sent from here keep their row key) followed by what is still on its way or failed. */
export function withPending(messages: Message[], pending: Pending[], aliases: Map<string, string>): Message[] {
  const ids = new Set(messages.map((m) => m.id));
  // A stored copy can arrive (webhook) before the send call returns its id: match it by content among the messages that were not there before.
  for (const p of pending) {
    if (p.serverId || p.message.failed) continue;
    const hit = messages.find((m) => m.fromMe && !p.known.has(m.id) && !aliases.has(m.id) && sameContent(m, p.message));
    if (hit) aliases.set(hit.id, p.message.id);
  }
  const taken = new Set<string>();
  const out = messages.map((m) => { const local = aliases.get(m.id); if (!local) return m; taken.add(local); return { ...m, localId: local }; });
  for (const p of pending) if (!taken.has(p.message.id) && !(p.serverId && ids.has(p.serverId))) out.push(p.message);
  return out;
}

const PAGE = 80;
const LOGIN_STATES = ["SCAN_QR_CODE", "MISSING", "STOPPED", "FAILED", "STARTING", "PASSKEY_REQUIRED", "PASSKEY_CONFIRMATION_REQUIRED"];

/** Shows the connection screen instead of the inbox while WhatsApp is not linked: always when there is nothing to read yet, on request otherwise. */
function SessionGate({ hasChats, open, onClose, onConnected, children }: { hasChats: boolean; open: boolean; onClose: () => void; onConnected: () => void; children: ReactNode }) {
  const { info } = useSessionInfo();
  const down = info !== null && info.status !== "WORKING";
  const was = useRef(false);
  useEffect(() => { if (info?.status === "WORKING" && was.current) onConnected(); was.current = down; }, [info?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (down && (open || (!hasChats && LOGIN_STATES.includes(info.status)))) {
    return (
      <div className="wa-gate">
        {hasChats && <Button type="button" variant="ghost" size="sm" className="wa-gate-back" onClick={onClose}><IconArrowLeft />Back to chats</Button>}
        <SessionScreen onConnected={onConnected} />
      </div>
    );
  }
  return <>{children}</>;
}
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
/** A plugin event of one account (the inbox itself is above the context its children read). */
function useWaEventHere<T>(pluginId: string, session: string, name: string, fn: (data: T) => void) {
  usePluginEvent<T>(pluginId, name, (data) => { const s = (data as { session?: unknown } | null)?.session; if (typeof s === "string" && s !== session) return; fn(data); });
}
const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
  r.onerror = () => reject(new Error("Could not read the file."));
  r.readAsDataURL(blob);
});
/** What a refused request means, in the user's words. */
function explain(e: unknown): string {
  if (errorCode(e) === "unsupported" || errorStatus(e) === 501) return "Your WAHA engine does not support this.";
  if (errorCode(e) === "payload_too_large" || errorStatus(e) === 413) return "The file is too large to send from Floq. Update Floq if you are on an older version, or send a smaller file.";
  return errorText(e);
}

/**
 * The WhatsApp view: which accounts are attached and which one is on screen. Each account gets its own inbox (mounted per account, so nothing of
 * one account is ever shown or sent in another), with a route caller that names the account's session on every request.
 */
export default function InboxView({ plugin, view }: PluginViewProps) {
  const base = usePluginApi(plugin.id) as Api;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [adding, setAdding] = useState(false);
  const loadStatus = useCallback(async () => {
    setPhase({ kind: "loading" });
    try { setPhase({ kind: "ready", status: await base<Status>("/status") }); }
    catch (e) { setPhase(errorStatus(e) === 403 ? { kind: "forbidden" } : { kind: "error", message: errorText(e) }); }
  }, [base]);
  useEffect(() => { void loadStatus(); }, [loadStatus]);
  const configured = phase.kind === "ready" && phase.status.configured;
  const { list, error, active, switchTo, refresh } = useAccountList(plugin.id, base, configured);
  const accounts = useMemo<Accounts>(() => ({ list: list ?? [], active, switchTo, refresh, add: () => setAdding(true) }), [list, active, switchTo, refresh]);
  const api = useMemo(() => scopedApi(base, active), [base, active]);
  // "Open chat" of a notification: switch to its account, then open the chat there.
  const [wanted, setWanted] = useState<{ chat: string; session: string; n: number } | null>(null);
  useOpenFromHost(plugin.id, view.id, (params) => {
    if (!params.chat) return;
    if (params.session && params.session !== active && (list ?? []).some((a) => a.session === params.session)) switchTo(params.session);
    setWanted((old) => ({ chat: params.chat, session: params.session ?? "", n: (old?.n ?? 0) + 1 }));
  });

  if (phase.kind === "loading" || (configured && list === null && !error)) return <PluginPage title="WhatsApp"><PluginState state="loading" label="WhatsApp" /></PluginPage>;
  if (phase.kind === "error") return <PluginPage title="WhatsApp"><PluginState state="error" title="Could not load WhatsApp" description={phase.message} onRetry={() => void loadStatus()} /></PluginPage>;
  if (phase.kind === "forbidden") return <PluginPage title="WhatsApp"><PluginState state="empty" title="Only the administrator who set this up can use the inbox" description="Messages are private to them." /></PluginPage>;
  if (!phase.status.configured) {
    return <PluginPage title="WhatsApp"><PluginState state="not-configured" title="Connect WAHA" description="Add your WAHA address and API key, then point a WAHA webhook at Floq." missingSecrets={phase.status.missingSecrets} missingSettings={phase.status.missingSettings} /></PluginPage>;
  }
  if (list === null) return <PluginPage title="WhatsApp"><PluginState state="error" title="Could not load your WhatsApp accounts" description={error} onRetry={() => void refresh()} /></PluginPage>;
  const added = async (session: string) => { await refresh(); switchTo(session); };
  return (
    <AccountsContext.Provider value={accounts}>
      {active ? <AccountInbox key={active} plugin={plugin} view={view} api={api} session={active} wanted={wanted && (!wanted.session || wanted.session === active) ? wanted : null} status={phase.status} account={list.find((a) => a.session === active) ?? null} many={list.length > 1} /> : (
        <div className="wa-root">
          <style>{CSS + SESSION_CSS}</style>
          <div className="wa-noacct">
            <div className="wa-hello">
              <span className="wa-hero"><IconUserPlus /></span>
              <span className="wa-hero-title">No WhatsApp account yet</span>
              <p>Link a phone with a QR code, or attach a session that already runs in your WAHA. You can add as many accounts as you like.</p>
              <Button type="button" onClick={() => setAdding(true)}><IconUserPlus />Add account</Button>
            </div>
          </div>
        </div>
      )}
      <AddAccountDialog open={adding} onOpenChange={setAdding} api={base} pluginId={plugin.id} onAdded={added} />
    </AccountsContext.Provider>
  );
}

/** The inbox of one account: chat list, conversation and its side panels. Everything sent here is the user's own click, from this account. */
function AccountInbox({ plugin, api, session, status: first, account, many, wanted }: PluginViewProps & { api: Api; session: string; status: Status; account: Account | null; many: boolean; wanted?: { chat: string; n: number } | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: "ready", status: first });
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [archived, setArchived] = useState<Chat[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [me, setMe] = useState<Wa["me"]>(null);
  const [chatsError, setChatsError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [hints, setHints] = useState<Record<string, Partial<Chat>>>({});
  const [pane, setPane] = useState<"list" | "chat">("list");
  const [messages, setMessages] = useState<Message[] | null>(null);
  /** Incoming messages WhatsApp was not told were read (drives the "Mark as read" button). */
  const [receiptPending, setReceiptPending] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [messagesError, setMessagesError] = useState("");
  // Drafts are not state: the composer owns its text, so typing renders nothing here. This only remembers each chat's text for when it is opened again.
  const drafts = useRef<Record<string, string>>({});
  /** Stored message id -> the row key of the bubble that was shown while it was sent. */
  const aliases = useRef(new Map<string, string>());
  const [pending, setPending] = useState<Pending[]>([]);
  const [replies, setReplies] = useState<Record<string, Quote | null>>({});
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [sendingId, setSendingId] = useState("");
  const [info, setInfo] = useState(false);
  const [newChat, setNewChat] = useState(false);
  const [side, setSide] = useState<"" | "status" | "channels" | "contacts">("");
  const [connect, setConnect] = useState(false);
  const [label, setLabel] = useState("");
  const [now, setNow] = useState(() => new Date());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const showArchivedRef = useRef(showArchived);
  showArchivedRef.current = showArchived;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const seq = useRef(0);
  const loadingMore = useRef(false);

  const loadStatus = useCallback(async () => {
    try { const status = await api<Status>("/status"); setPhase({ kind: "ready", status }); if (status.me) setMe(status.me); }
    catch (e) { setPhase(errorStatus(e) === 403 ? { kind: "forbidden" } : { kind: "error", message: errorText(e) }); }
  }, [api]);

  // Silent after the first load: the old list stays on screen, a failed refresh only matters when there is nothing to show.
  const loadChats = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await api<{ chats: Chat[]; archivedCount?: number; me?: Wa["me"] }>("/chats");
      const list = res.chats ?? [];
      setChatsError("");
      if (res.me) setMe(res.me);
      setArchivedCount(res.archivedCount ?? 0);
      // The open chat is being read: do not flash its unread pill back.
      setChats(visible() ? list.map((c) => (c.chatId === selectedRef.current && c.unread && !c.markedUnread ? { ...c, unread: 0 } : c)) : list);
      if (showArchivedRef.current || (res.archivedCount ?? 0) > 0) setArchived((await api<{ chats: Chat[] }>("/chats?archived=1")).chats ?? []);
      else setArchived([]);
    } catch (e) { setChatsError(errorText(e)); }
    finally { setRefreshing(false); }
  }, [api]);

  const loadMessages = useCallback(async (chatId: string) => {
    try {
      const res = await api<{ messages: Message[]; more?: boolean; receiptPending?: number }>(`/messages?chatId=${encodeURIComponent(chatId)}&limit=${PAGE}`);
      if (selectedRef.current !== chatId) return;
      setMessagesError("");
      setReceiptPending(res.receiptPending ?? 0);
      // Older pages already loaded stay; the newest page replaces its part.
      setMessages((old) => {
        const fresh = res.messages ?? [];
        if (!old || !fresh.length) return fresh;
        const first = fresh[0].sentAt, ids = new Set(fresh.map((m) => m.id));
        return [...old.filter((m) => m.sentAt < first && !ids.has(m.id)), ...fresh];
      });
      setHasMore((h) => h || res.more === true);
    } catch (e) { if (selectedRef.current === chatId) setMessagesError(errorText(e)); }
  }, [api]);

  const loadMore = useCallback(async () => {
    const chatId = selectedRef.current;
    if (!chatId || loadingMore.current) return;
    loadingMore.current = true;
    try {
      const first = messagesRef.current?.[0]?.sentAt;
      if (!first) return;
      const res = await api<{ messages: Message[]; more?: boolean }>(`/messages?chatId=${encodeURIComponent(chatId)}&limit=${PAGE}&before=${encodeURIComponent(first)}`);
      if (selectedRef.current !== chatId) return;
      setMessages((old) => { const ids = new Set((old ?? []).map((m) => m.id)); return [...(res.messages ?? []).filter((m) => !ids.has(m.id)), ...(old ?? [])]; });
      setHasMore(res.more === true);
    } catch { /* stays as it is; scrolling up again retries */ }
    finally { loadingMore.current = false; }
  }, [api]);

  const markRead = useCallback(async (chatId: string) => {
    setChats((cs) => cs && cs.map((c) => (c.chatId === chatId && c.unread ? { ...c, unread: 0, markedUnread: false } : c)));
    // Only Floq's own badge: WhatsApp is told by the "Mark as read" button, by sending, or by the account's automatic-receipts setting.
    try { await api("/read", { method: "POST", body: { chatId, local: true } }); } catch { /* the pill returns with the next refresh */ }
  }, [api]);
  const sendReceipt = useCallback(async () => {
    const chatId = selectedRef.current;
    if (!chatId) return;
    setReceiptPending(0);
    try { await api("/read", { method: "POST", body: { chatId } }); toast.success("Read receipt sent"); void loadChats(); }
    catch (e) { toast.error("Could not send the read receipt", { description: explain(e) }); void loadMessages(chatId); }
  }, [api, loadChats, loadMessages]);

  // The shell's status was read for the default account: this account's engine and features come from its own.
  useEffect(() => { if (first.session !== session) void loadStatus(); else if (first.me) setMe(first.me); }, [loadStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (phase.kind === "ready" && phase.status.configured) void loadChats(); }, [phase, loadChats]);
  useEffect(() => {
    if (!selected) return;
    setMessages(null); setMessagesError(""); setHasMore(false); setEditing(null); setReceiptPending(0);
    aliases.current.clear(); // the log is mounted anew for another chat: no row to keep
    void loadMessages(selected);
    void markRead(selected);
  }, [selected, loadMessages, markRead]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const onVisible = () => {
      const id = selectedRef.current;
      if (visible() && id && chatsRef.current?.some((c) => c.chatId === id && c.unread)) void markRead(id);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [markRead]);

  useWaEventHere<{ chatId?: string; ids?: string[]; fromMe?: boolean; sync?: boolean }>(plugin.id, session, "message", (data) => {
    const open = selectedRef.current;
    // The event names the canonical id; the open chat may be held under another address of the same chat (an @lid, the other spelling of a
    // number) until the list is read again. Then any message of this account may be for it, and re-reading the log is cheap.
    const ours = Boolean(open) && (!data?.chatId || data.chatId === open || data.ids?.includes(open) || !chatsRef.current?.some((c) => c.chatId === open));
    if (ours && open) {
      void loadMessages(open);
      if (visible() && data?.fromMe === false) { void markRead(open).then(() => loadChats()); return; }
    }
    void loadChats();
  });
  // A message that reached Floq without a webhook (the chat list sync) only brings "chats": the open log still has to show it.
  useWaEventHere(plugin.id, session, "chats", () => { const open = selectedRef.current; if (open) void loadMessages(open); void loadChats(); });

  const openChat = useCallback((chatId: string, hint?: Partial<Chat>) => {
    if (hint) setHints((h) => ({ ...h, [chatId]: { ...h[chatId], ...hint } }));
    setSelected(chatId); setPane("chat"); setInfo(false);
  }, []);
  const closeChat = useCallback(() => { setSelected(""); setPane("list"); setInfo(false); }, []);
  useEffect(() => { if (wanted?.chat) openChat(wanted.chat); }, [wanted?.chat, wanted?.n, openChat]);
  useNotifyFocus(api, selected);

  const status = phase.kind === "ready" ? phase.status : null;
  const engine: Engine = status?.engine ?? "";
  const features = useMemo(() => status?.features ?? featuresOf(engine), [status, engine]);
  const everyChat = useMemo(() => [...(chats ?? []), ...archived.filter((a) => !(chats ?? []).some((c) => c.chatId === a.chatId))], [chats, archived]);
  const wa = useMemo<Wa>(() => ({ pluginId: plugin.id, api, session, engine, features, me, chats: everyChat, refreshChats: () => void loadChats(), openChat, useAvatar: useAvatarUrl }), [plugin.id, api, session, engine, features, me, everyChat, loadChats, openChat]);

  /**
   * Shows the bubble at once (a clock in its time row), runs the request, then shows one tick and lets the stored message take the same row.
   * When it fails the bubble stays, marked "Not sent" with Retry (keepFailed) or goes away (a dialog that stays open to try again). Returns false when it failed.
   */
  async function deliver(chatId: string, optimistic: Omit<Message, "id" | "fromMe" | "sender" | "sentAt" | "pending">, run: () => Promise<unknown>, failTitle: string, keepFailed = true, id = `pending-${++seq.current}`): Promise<boolean> {
    setReceiptPending(0); // sending reads the chat first (the runtime sends the receipt)
    const message: Message = { ...optimistic, id, localId: id, fromMe: true, sender: "", sentAt: new Date().toISOString(), pending: true };
    const entry: Pending = { chatId, message, known: new Set((selectedRef.current === chatId ? messagesRef.current ?? [] : []).map((m) => m.id)), retry: () => void deliver(chatId, optimistic, run, failTitle, keepFailed, id) };
    const patch = (fn: (p: Pending) => Pending | null) => setPending((list) => list.flatMap((x) => { if (x.message.id !== id) return [x]; const next = fn(x); return next ? [next] : []; }));
    setPending((list) => (list.some((x) => x.message.id === id) ? list.map((x) => (x.message.id === id ? entry : x)) : [...list, entry]));
    try {
      const res = await run() as { id?: unknown } | null | undefined;
      const serverId = typeof res?.id === "string" && res.id ? res.id : undefined;
      if (serverId) aliases.current.set(serverId, id);
      patch((x) => ({ ...x, serverId, message: { ...x.message, pending: false, ack: 1 } }));
      await loadMessages(chatId);
      void loadChats();
      // A runtime that does not say which message it stored: nothing can take the row over, so the bubble goes as the log is read again.
      if (!serverId) patch((x) => (x.serverId ? x : null));
      return true;
    } catch (e) {
      toast.error(failTitle, { description: explain(e) });
      patch((x) => (keepFailed ? { ...x, message: { ...x.message, pending: false, failed: true } } : null));
      return false;
    }
  }
  // A bubble sent from here leaves the pending list once the stored message is in the log (it shows in the same row).
  useEffect(() => {
    if (!messages || !pending.length) return;
    const ids = new Set(messages.map((m) => m.id)), taken = new Set(messages.flatMap((m) => aliases.current.get(m.id) ?? []));
    const left = pending.filter((p) => p.chatId !== selected || !(taken.has(p.message.id) || (p.serverId && ids.has(p.serverId))));
    if (left.length !== pending.length) setPending(left);
  }, [messages, pending, selected]);
  // One array per change of the log: the memoized message list is not handed a new one on every render of this screen.
  const shownMemo = useMemo(() => messages && withPending(messages, pending.filter((p) => p.chatId === selected), aliases.current), [messages, pending, selected]);

  async function send(payload: { text: string; attachments: Attachment[] }) {
    const chatId = selected;
    const text = payload.text.trim();
    if (!chatId || sendingId === chatId) return;
    if (editing) {
      const target = editing;
      if (!text) return;
      setEditing(null);
      setMessages((ms) => ms && ms.map((m) => (m.id === target.id ? { ...m, body: text, edited: true } : m)));
      try { await api("/edit", { method: "POST", body: { messageId: target.id, text } }); }
      catch (e) { toast.error("Message not edited", { description: explain(e) }); }
      void loadMessages(chatId);
      return;
    }
    if (!text && !payload.attachments.length) return;
    const replyTo = replies[chatId] ?? null;
    const chat = everyChat.find((c) => c.chatId === chatId);
    setReplies((r) => ({ ...r, [chatId]: null }));
    setSendingId(chatId);
    try {
      if (!payload.attachments.length) {
        const mentions = chat?.kind === "group" ? mentionsIn(text, mentionList.current) : [];
        // A failed send stays in the log as a "Not sent" bubble with Retry: the text is not lost and the field is free for the next message.
        await deliver(chatId, { body: text, hasMedia: false, type: "chat", replyTo }, () => api("/send", { method: "POST", body: { chatId, text, ...(replyTo ? { replyTo: replyTo.id } : {}), ...(mentions.length ? { mentions } : {}) } }), "Message not sent");
        return;
      }
      // One message per file, in order; the caption and the reply go on the first.
      for (const [i, a] of payload.attachments.entries()) {
        const kind = kindOfFile(a.file);
        const localUrl = kind === "image" || kind === "video" ? URL.createObjectURL(a.file) : undefined;
        const caption = i === 0 ? text : "";
        await deliver(chatId, { body: caption, hasMedia: true, type: kind as MessageType, replyTo: i === 0 ? replyTo : null, localUrl, media: { mime: a.file.type, filename: a.file.name, size: a.file.size, duration: null, width: null, height: null, available: true } },
          async () => api("/send-media", { method: "POST", body: { chatId, kind, mime: a.file.type || "application/octet-stream", filename: a.file.name, data: await toBase64(a.file), ...(caption ? { caption } : {}), ...(i === 0 && replyTo ? { replyTo: replyTo.id } : {}) } }),
          `${a.file.name} was not sent`);
        if (localUrl) setTimeout(() => URL.revokeObjectURL(localUrl), 30_000);
      }
    } finally { setSendingId(""); }
  }

  async function sendVoice(blob: Blob, durationMs: number) {
    const chatId = selected, replyTo = replies[chatId] ?? null;
    setReplies((r) => ({ ...r, [chatId]: null }));
    await deliver(chatId, { body: "", hasMedia: true, type: "ptt", replyTo, media: { mime: blob.type, filename: "", size: blob.size, duration: Math.round(durationMs / 1000), width: null, height: null, available: false } },
      async () => api("/send-media", { method: "POST", body: { chatId, kind: "voice", mime: blob.type || "audio/ogg", filename: "voice-message", data: await toBase64(blob), duration: Math.round(durationMs / 1000), ...(replyTo ? { replyTo: replyTo.id } : {}) } }),
      "Voice message not sent");
  }

  const mentionList = useRef<{ id: string; name: string; phone?: string }[]>([]);
  const handlers: ConversationHandlers = {
    onReply: (m) => setReplies((r) => ({ ...r, [selected]: quoteOf(m) })),
    onCancelReply: () => setReplies((r) => ({ ...r, [selected]: null })),
    onEdit: (m) => { setReplies((r) => ({ ...r, [selected]: null })); setEditing({ id: m.id, body: m.body }); },
    onCancelEdit: () => setEditing(null),
    onBack: () => setPane("list"),
    onRetry: () => void loadMessages(selected),
    onDraft: (v) => { drafts.current[selected] = v; },
    onSend: (p) => void send(p),
    onSendVoice: (b, d) => void sendVoice(b, d),
    onTyping: (state) => { void api("/typing", { method: "POST", body: { chatId: selected, state } }).catch(() => undefined); },
    onLoadMore: () => void loadMore(),
    onMentions: (list) => { mentionList.current = list; },
    /** Message actions from the bubble menu. The row updates at once and settles with the next read. */
    onAction: async (action, m, arg) => {
      const chatId = selected;
      // a bubble that was not sent: try again in the same bubble, or take it away
      if (action === "retry") { pending.find((p) => p.message.id === m.id)?.retry(); return; }
      if (action === "discard") { setPending((list) => list.filter((p) => p.message.id !== m.id)); return; }
      const patch = (fn: (x: Message) => Message) => setMessages((ms) => ms && ms.map((x) => (x.id === m.id ? fn(x) : x)));
      const settle = () => { if (selectedRef.current === chatId) void loadMessages(chatId); };
      // The log shows a reaction at once and takes it back itself when this throws.
      if (action === "react") {
        try { await api("/react", { method: "POST", body: { messageId: m.id, emoji: typeof arg === "string" ? arg : "" } }); }
        catch (e) { throw new Error(explain(e)); }
        finally { settle(); }
        return;
      }
      try {
        if (action === "star") { const star = typeof arg === "boolean" ? arg : !m.starred; patch((x) => ({ ...x, starred: star })); await api("/star", { method: "POST", body: { messageId: m.id, star } }); }
        else if (action === "pin") { const pin = typeof arg === "boolean" ? arg : !m.pinned; patch((x) => ({ ...x, pinned: pin })); await api("/pin", { method: "POST", body: { messageId: m.id, pin } }); }
        else if (action === "delete") { await api("/delete", { method: "POST", body: { messageId: m.id, forEveryone: (arg as { forEveryone?: boolean } | undefined)?.forEveryone === true } }); void loadChats(); }
        else if (action === "forward") { const to = Array.isArray(arg) ? arg : []; if (!to.length) return; await api("/forward", { method: "POST", body: { messageId: m.id, to } }); toast.success(to.length === 1 ? "Message forwarded" : `Forwarded to ${to.length} chats`); void loadChats(); }
        else if (action === "vote") { await api("/poll-vote", { method: "POST", body: { messageId: m.id, options: Array.isArray(arg) ? arg : [] } }); }
      } catch (e) {
        toast.error({ star: "Could not star the message", pin: "Could not pin the message", delete: "Message not deleted", forward: "Message not forwarded", vote: "Vote not sent" }[action as string] ?? "That did not work", { description: explain(e) });
        if (action === "forward") throw e;
      }
      settle();
    },
    onExtraSend: async (kind, body) => {
      const chatId = selected, replyTo = replies[chatId] ?? null;
      setReplies((r) => ({ ...r, [chatId]: null }));
      const path = kind === "poll" ? "/send-poll" : kind === "location" ? "/send-location" : "/send-contact";
      const type: MessageType = kind === "poll" ? "poll" : kind === "location" ? "location" : "vcard";
      return deliver(chatId, { body: "", hasMedia: false, type, replyTo }, () => api(path, { method: "POST", body: { chatId, ...body, ...(replyTo ? { replyTo: replyTo.id } : {}) } }), kind === "poll" ? "Poll not sent" : kind === "location" ? "Location not sent" : "Contact not sent", false);
    },
  };

  if (phase.kind === "loading") return <PluginPage title="WhatsApp"><PluginState state="loading" label="WhatsApp" /></PluginPage>;
  if (phase.kind === "error") return <PluginPage title="WhatsApp"><PluginState state="error" title="Could not load WhatsApp" description={phase.message} onRetry={() => void loadStatus()} /></PluginPage>;
  if (phase.kind === "forbidden") return <PluginPage title="WhatsApp"><PluginState state="empty" title="Only the administrator who set this up can use the inbox" description="Messages are private to them." /></PluginPage>;
  if (!phase.status.configured) {
    return <PluginPage title="WhatsApp"><PluginState state="not-configured" title="Connect WAHA" description="Add your WAHA address and API key, then point a WAHA webhook at Floq." missingSecrets={phase.status.missingSecrets} missingSettings={phase.status.missingSettings} /></PluginPage>;
  }

  const chat: Chat | null = selected ? everyChat.find((c) => c.chatId === selected) ?? { chatId: selected, lastBody: "", lastAt: "", total: 0, ...hints[selected] } : null;
  const shown = shownMemo;

  return (
    <WaContext.Provider value={wa}>
      <div className="wa-root" data-pane={pane} data-engine={engine || undefined}>
        <style>{CSS}</style>
        <SessionGate hasChats={(chats?.length ?? 0) + archivedCount > 0} open={connect} onClose={() => setConnect(false)} onConnected={() => { setConnect(false); void loadStatus(); }}>
        <div className="wa-panel">
          <ChatList chats={showArchived ? archived : chats} error={chatsError} selected={selected} query={query} now={now} refreshing={refreshing} archivedCount={archivedCount} showArchived={showArchived}
            onArchived={(v) => { setShowArchived(v); if (v) void loadChats(); }} onQuery={setQuery} onSelect={(id) => openChat(id)} onRefresh={() => void loadChats()}
            rowMenu={(c) => <ChatMenu chat={c} onInfo={() => { openChat(c.chatId); setInfo(true); }} onGone={() => { if (selectedRef.current === c.chatId) closeChat(); }} />}
            rowExtra={(c) => <LabelChips ids={c.labels} max={1} />}
            filterExtra={features.labels ? <LabelFilter value={label} onChange={setLabel} /> : null}
            passes={label ? (c) => (c.labels ?? []).includes(label) : undefined}
            banner={<><SessionBanner onOpenConnect={() => setConnect(true)} /><HistoryBar /></>}
            overlay={side === "status" ? <StatusView onClose={() => setSide("")} /> : side === "channels" ? <ChannelsView onClose={() => setSide("")} /> : side === "contacts" ? <ContactsView onClose={() => setSide("")} onOpen={(c, info) => { setSide(""); openChat(c.chatId, { kind: "user", name: c.name || c.pushName || c.businessName, phone: c.phone }); if (info) setInfo(true); }} /> : null}
            actions={(<>
              {features.status && <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" className="wa-iconbtn" aria-label="Status" onClick={() => setSide("status")}><IconStatus /></Button></TooltipTrigger><TooltipContent>Status</TooltipContent></Tooltip>}
              {features.channels && <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" className="wa-iconbtn" aria-label="Channels" onClick={() => setSide("channels")}><IconMegaphone /></Button></TooltipTrigger><TooltipContent>Channels</TooltipContent></Tooltip>}
              <Tooltip>
                <TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" className="wa-iconbtn" aria-label="New chat" onClick={() => setNewChat(true)}><IconNewChat /></Button></TooltipTrigger>
                <TooltipContent>New chat</TooltipContent>
              </Tooltip>
              <AccountMenu onContacts={() => setSide("contacts")} />
            </>)} />
          {chat ? (
            <Conversation chat={chat} messages={shown} hasMore={hasMore} error={messagesError} now={now} draft={drafts.current[selected] ?? ""} sending={sendingId === selected} focusToken={selected}
              reply={replies[selected] ?? null} editing={editing} handlers={handlers} receiptPending={receiptPending} onMarkRead={sendReceipt}
              onInfo={() => setInfo((v) => !v)} menu={<>{many && account && <span className="wa-chip-acct" title={`This chat belongs to ${accountName(account)}. Replies go out from that account.`} aria-label={`Account: ${accountName(account)}`}><i style={{ "--wa-h": accountHue(account) } as CSSProperties} aria-hidden="true" /><span>{accountName(account)}</span></span>}{features.labels && chat.kind !== "group" && <LabelPicker chat={chat} />}<ChatMenu chat={chat} onInfo={() => setInfo(true)} onGone={closeChat} /></>}
              presence={features.presence && !chat.isSelf ? <PresenceLine chat={chat} fallback={subtitle(chat)} /> : undefined} />
          ) : <EmptyConversation session={session} account={many && account ? accountName(account) : ""} />}
          {chat && info && <InfoPanel key={chat.chatId} chat={chat} onClose={() => setInfo(false)} />}
        </div>
        </SessionGate>
        <NewChatDialog open={newChat} onOpenChange={setNewChat} />
        {features.calls && <CallBanner />}
      </div>
    </WaContext.Provider>
  );
}
