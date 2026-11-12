import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import type { JSONContent } from "@tiptap/core";
import {
  IconArrowUp, IconBold, IconBraces, IconCheck, IconCode, IconItalic, IconLink, IconList, IconMessage, IconPaperclip, IconX,
} from "@tabler/icons-react";
import { Panel } from "@xyflow/react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { STATE_DOT } from "@/components/agents/session-terminal";
import { pastedTauriImage, pastedFiles, AttachmentChips, useAttachments, useTauriDrop } from "./canvas-attachments";
import { sendToTargets } from "./canvas-send";
import { orchestratorIds } from "@/lib/runtime/orchestrator";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { SessionSummary } from "@/lib/runtime/types";
import { askText } from "@/components/ui/ask-dialog";

const COLLAPSED_KEY = "floq.canvasComposer.collapsed";
const draftKey = (projectId: string) => `floq.canvasComposer.draft.${projectId}`;
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

type Node = JSONContent;
function inline(node: Node): string {
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return `@${node.attrs?.label ?? node.attrs?.id ?? ""}`;
  let text = node.text ?? "";
  for (const mark of node.marks ?? []) {
    if (mark.type === "bold") text = `**${text}**`;
    else if (mark.type === "italic") text = `_${text}_`;
    else if (mark.type === "strike") text = `~~${text}~~`;
    else if (mark.type === "code") text = `\`${text}\``;
    else if (mark.type === "link") text = `[${text}](${mark.attrs?.href ?? ""})`;
  }
  return text;
}
function block(node: Node, depth = 0): string {
  const kids = node.content ?? [];
  switch (node.type) {
    case "paragraph": return kids.map(inline).join("");
    case "heading": return `${"#".repeat(node.attrs?.level ?? 1)} ${kids.map(inline).join("")}`;
    case "codeBlock": return `\`\`\`${node.attrs?.language ?? ""}\n${kids.map((kid) => kid.text ?? "").join("")}\n\`\`\``;
    case "blockquote": return kids.map((kid) => block(kid, depth)).join("\n").split("\n").map((line) => `> ${line}`).join("\n");
    case "bulletList": return kids.map((item) => `${"  ".repeat(depth)}- ${(item.content ?? []).map((child) => block(child, depth + 1)).join("\n")}`).join("\n");
    case "orderedList": return kids.map((item, index) => `${"  ".repeat(depth)}${index + 1}. ${(item.content ?? []).map((child) => block(child, depth + 1)).join("\n")}`).join("\n");
    default: return kids.map((kid) => block(kid, depth)).join("\n");
  }
}
export const toMarkdown = (doc: Node) => (doc.content ?? []).map((node) => block(node)).join("\n\n").trim();
function mentionIds(node: Node, found: string[] = []): string[] {
  if (node.type === "mention" && node.attrs?.id) found.push(node.attrs.id as string);
  for (const kid of node.content ?? []) mentionIds(kid, found);
  return found;
}

interface MentionState { items: { id: string; label: string }[]; index: number; command: (item: { id: string; label: string }) => void; rect: DOMRect | null }

interface Props {
  projectId: string;
  client: RuntimeClient | null;
  sessions: SessionSummary[];
  selectedIds: string[];
  wake: (session: SessionSummary) => Promise<void>;
  onSent: (ids: string[], preview: string) => void;
  focusRef: React.MutableRefObject<(() => void) | null>;
}

export default function CanvasComposer({ projectId, client, sessions, selectedIds, wake, onSent, focusRef }: Props) {
  const [collapsed, setCollapsed] = useState(() => read(COLLAPSED_KEY) === "1");
  const [explicit, setExplicit] = useState<string[] | null>(null);
  const [all, setAll] = useState(false);
  const [phase, setPhase] = useState<"idle" | "sending" | "sent">("idle");
  const [dropHover, setDropHover] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  const mentionRef = useRef<MentionState | null>(null);
  mentionRef.current = mention;
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachments = useAttachments();

  // ---- recipients: explicit choice, else the selected nodes, else the lead agent ----
  const running = useMemo(() => sessions.filter((session) => session.state === "running" || session.state === "starting"), [sessions]);
  const auto = useMemo(() => {
    const picked = selectedIds.filter((id) => sessions.some((session) => session.id === id));
    if (picked.length) return picked;
    const leads = orchestratorIds(sessions);
    const lead = running.find((session) => leads.has(session.id)) ?? running.find((session) => !session.parentSessionId) ?? running[0] ?? sessions.find((session) => leads.has(session.id)) ?? sessions.find((session) => !session.parentSessionId) ?? sessions[0];
    return lead ? [lead.id] : [];
  }, [selectedIds, sessions, running]);
  // Selecting nodes on the canvas takes over again from a stale manual choice.
  const selectionKey = selectedIds.join(",");
  useEffect(() => { setExplicit(null); setAll(false); }, [selectionKey]);
  const targetIds = all ? running.map((session) => session.id) : (explicit ?? auto).filter((id) => sessions.some((session) => session.id === id));
  const targets = targetIds.map((id) => sessions.find((session) => session.id === id)).filter((session): session is SessionSummary => !!session);

  const latest = useRef({ targetIds, sessions, client, wake, onSent, projectId, targets });
  latest.current = { targetIds, sessions, client, wake, onSent, projectId, targets };
  const sendRef = useRef<() => void>(() => undefined);
  const addFilesRef = useRef(attachments.addFiles);
  addFilesRef.current = attachments.addFiles;
  const addItemsRef = useRef(attachments.add);
  addItemsRef.current = attachments.add;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, horizontalRule: false, link: { openOnClick: false, autolink: true } }),
      Placeholder.configure({ placeholder: "Message your agents…  @ to mention, Enter to send, Shift+Enter for a new line" }),
      Mention.configure({
        HTMLAttributes: { class: "rounded bg-primary/15 px-1 text-primary-text" },
        suggestion: {
          char: "@",
          items: ({ query }) => latest.current.sessions
            .filter((session) => session.title.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 8)
            .map((session) => ({ id: session.id, label: session.title })),
          render: () => ({
            onStart: (props) => setMention({ items: props.items as MentionState["items"], index: 0, command: props.command, rect: props.clientRect?.() ?? null }),
            onUpdate: (props) => setMention((current) => ({ items: props.items as MentionState["items"], index: Math.min(current?.index ?? 0, Math.max(0, props.items.length - 1)), command: props.command, rect: props.clientRect?.() ?? null })),
            onKeyDown: ({ event }) => {
              const state = mentionRef.current;
              if (!state || !state.items.length) return false;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const step = event.key === "ArrowDown" ? 1 : -1;
                setMention({ ...state, index: (state.index + step + state.items.length) % state.items.length });
                return true;
              }
              if (event.key === "Enter" || event.key === "Tab") { state.command(state.items[state.index]); return true; }
              return false;
            },
            onExit: () => setMention(null),
          }),
        },
      }),
    ],
    content: (() => { const saved = read(draftKey(projectId)); try { return saved ? (JSON.parse(saved) as JSONContent) : ""; } catch { return ""; } })(),
    editorProps: {
      attributes: {
        class: "min-h-[1.5rem] max-h-[40vh] overflow-y-auto px-1 py-0.5 outline-none [&_a]:text-primary-text [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_pre]:font-mono [&_pre]:text-[12px] [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0 [&_pre]:my-1 [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5 [&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-muted-foreground/70 [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
      },
      handleKeyDown: (view, event) => {
        if (mentionRef.current) return false;
        if (event.key === "Escape") { (view.dom as HTMLElement).blur(); return true; }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { sendRef.current(); return true; }
        const $from = view.state.selection.$from;
        const inList = $from.depth >= 2 && $from.node($from.depth - 1).type.name === "listItem";
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !inList && $from.parent.type.name !== "codeBlock") {
          sendRef.current();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files = pastedFiles(event);
        if (files) { event.preventDefault(); addFilesRef.current(files); return true; }
        if (!event.clipboardData?.getData("text/plain")) void pastedTauriImage().then((items) => items.length && addItemsRef.current(items));
        return false;
      },
    },
    onUpdate: ({ editor: instance }) => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => write(draftKey(latest.current.projectId), instance.isEmpty ? null : JSON.stringify(instance.getJSON())), 400);
      const ids = mentionIds(instance.getJSON()).filter((id) => !latest.current.targetIds.includes(id) && latest.current.sessions.some((session) => session.id === id));
      if (ids.length) { setAll(false); setExplicit([...latest.current.targetIds, ...ids]); }
    },
  });
  useEffect(() => () => clearTimeout(saveTimer.current), []);
  focusRef.current = () => { setCollapsed(false); write(COLLAPSED_KEY, "0"); setTimeout(() => editor?.commands.focus("end"), 30); };

  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => ({
      empty: !instance || instance.isEmpty,
      bold: !!instance?.isActive("bold"), italic: !!instance?.isActive("italic"), code: !!instance?.isActive("code"),
      list: !!instance?.isActive("bulletList"), codeBlock: !!instance?.isActive("codeBlock"), link: !!instance?.isActive("link"),
    }),
  });

  async function send() {
    const { client: runtimeClient, targets: current } = latest.current;
    if (!runtimeClient || !editor || phase === "sending" || current.length === 0) return;
    const text = toMarkdown(editor.getJSON());
    if (!text && attachments.items.length === 0) return;
    setPhase("sending");
    attachments.resetProgress();
    const result = await sendToTargets({
      client: runtimeClient, targets: current, text, attachments: attachments.items, wake: latest.current.wake,
      getSession: (id) => latest.current.sessions.find((session) => session.id === id), onProgress: attachments.setFraction,
    });
    if (result.delivered.length) latest.current.onSent(result.delivered, text.length > 80 ? `${text.slice(0, 79)}…` : text);
    if (result.failed.length === 0 && result.skipped.length === 0 && result.delivered.length) {
      editor.commands.clearContent(true);
      write(draftKey(latest.current.projectId), null);
      attachments.clear();
      setPhase("sent");
      setTimeout(() => setPhase("idle"), 1400);
    } else {
      // Keep the draft; only the targets that did not receive it stay selected.
      const left = [...result.failed.map((item) => item.id), ...result.skipped];
      if (left.length) { setAll(false); setExplicit(left); }
      setPhase("idle");
    }
  }
  sendRef.current = () => void send();

  const removeTarget = (id: string) => { setAll(false); setExplicit(targetIds.filter((item) => item !== id)); };
  const setCollapsedPersist = (value: boolean) => { setCollapsed(value); write(COLLAPSED_KEY, value ? "1" : "0"); };
  const setHover = useCallback((value: boolean) => setDropHover(value), []);
  useTauriDrop(rootRef, attachments.add, setHover);

  const canSend = !!client && targets.length > 0 && (!state.empty || attachments.items.length > 0) && phase === "idle";
  const tool = (active: boolean, label: string, onClick: () => void, icon: React.ReactNode) => (
    <Button type="button" variant={active ? "secondary" : "ghost"} size="icon-xs" className="size-6" aria-label={label} aria-pressed={active} title={label} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{icon}</Button>
  );

  return (
    <Panel position="bottom-center" className="nodrag nopan nowheel mb-3!">
      {collapsed ? (
        <Button type="button" variant="outline" size="sm" className="animate-in rounded-full border-border bg-card/95 shadow-md fade-in motion-reduce:animate-none" onClick={() => setCollapsedPersist(false)}>
          <IconMessage size={14} />
          Message agents
        </Button>
      ) : (
        <div
          ref={rootRef}
          onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDropHover(true); } }}
          onDragLeave={() => setDropHover(false)}
          onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); setDropHover(false); attachments.addFiles(Array.from(event.dataTransfer.files)); } }}
          className={cn(
            "flex w-[min(640px,calc(100vw-470px))] min-w-80 animate-in flex-col gap-1.5 rounded-xl border bg-card/95 p-2 text-[13px] leading-5 shadow-lg duration-300 slide-in-from-bottom-4 fade-in motion-reduce:animate-none",
            "transition-[border-color,box-shadow] focus-within:border-primary/60 focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_18%,transparent)]",
            dropHover ? "border-primary border-dashed bg-primary/5" : "border-border",
          )}
        >
          <div className="flex flex-wrap items-center gap-1 text-[11px]">
            <span className="text-muted-foreground">To:</span>
            {all && <span className="animate-in rounded-md bg-primary/15 px-1.5 py-0.5 text-primary-text fade-in zoom-in-95">all running ({running.length})</span>}
            {!all && targets.map((session) => (
              <span key={session.id} className="flex animate-in items-center gap-1 rounded-md border border-border bg-muted/60 py-0.5 pr-0.5 pl-1.5 fade-in zoom-in-95 motion-reduce:animate-none">
                <AgentAvatar session={session} size={18} />
                <span className={cn("size-1.5 rounded-full", STATE_DOT[session.state])} />
                <span className="max-w-32 truncate">{session.title}</span>
                <Button variant="ghost" size="icon-xs" type="button" aria-label={`Remove ${session.title}`} className="size-4 rounded" onClick={() => removeTarget(session.id)}><IconX size={10} /></Button>
              </span>
            ))}
            {!all && targets.length === 0 && <span className="text-destructive">No agent to send to</span>}
          </div>

          <AttachmentChips items={attachments.items} progress={attachments.progress} uploading={phase === "sending"} onRemove={attachments.remove} />
          <EditorContent editor={editor} />

          <div className="flex items-center gap-0.5">
            {tool(state.bold, "Bold (**text**)", () => editor?.chain().focus().toggleBold().run(), <IconBold size={13} />)}
            {tool(state.italic, "Italic (_text_)", () => editor?.chain().focus().toggleItalic().run(), <IconItalic size={13} />)}
            {tool(state.code, "Inline code (`text`)", () => editor?.chain().focus().toggleCode().run(), <IconCode size={13} />)}
            {tool(state.codeBlock, "Code block (```)", () => editor?.chain().focus().toggleCodeBlock().run(), <IconBraces size={13} />)}
            {tool(state.list, "Bullet list (- )", () => editor?.chain().focus().toggleBulletList().run(), <IconList size={13} />)}
            {tool(state.link, "Link", () => {
              if (!editor) return;
              if (state.link) { editor.chain().focus().unsetLink().run(); return; }
              void askText({
                title: "Add a link",
                label: "Link URL",
                placeholder: "https://example.com",
                actionLabel: "Add link",
                validate: (value) => (/^(https?:\/\/|mailto:)\S+$/i.test(value) ? null : "Enter a full URL starting with https://, http:// or mailto:"),
              }).then((href) => {
                if (href) editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
                else editor.commands.focus();
              });
            }, <IconLink size={13} />)}
            <span className="mx-1 h-4 w-px bg-border" />
            {tool(false, "Attach files", () => fileInput.current?.click(), <IconPaperclip size={13} />)}
            <input ref={fileInput} type="file" multiple hidden onChange={(event) => { attachments.addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            <span className="ml-auto mr-1.5 hidden text-[10px] text-muted-foreground sm:inline">{phase === "sent" ? "Sent" : "Enter to send"}</span>
            <Button type="button" size="icon-sm" className="size-7 rounded-lg" disabled={!canSend && phase === "idle"} aria-label="Send message" aria-busy={phase === "sending"} title={targets.length ? "Send (Enter)" : "No agent to send to"} onClick={() => void send()}>
              <span key={phase} className="animate-in zoom-in-50 fade-in motion-reduce:animate-none">
                {phase === "sending" ? <Spinner /> : phase === "sent" ? <IconCheck size={15} /> : <IconArrowUp size={15} />}
              </span>
            </Button>
          </div>
        </div>
      )}

      {mention && mention.items.length > 0 && mention.rect && (
        <div className="fixed z-50 w-60 animate-in overflow-hidden rounded-lg border bg-popover p-1 text-xs text-popover-foreground shadow-lg fade-in zoom-in-95" style={{ left: mention.rect.left, bottom: window.innerHeight - mention.rect.top + 6 }}>
          {mention.items.map((item, index) => {
            const session = sessions.find((candidate) => candidate.id === item.id);
            return (
              <button key={item.id} type="button" className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", index === mention.index && "bg-muted")} onMouseDown={(event) => event.preventDefault()} onClick={() => mention.command(item)}>
                {session && <AgentAvatar session={session} size={18} />}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {session && <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[session.state])} />}
              </button>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
