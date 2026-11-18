import { useCallback, useEffect, useRef, useState } from "react";
import { handlePaste } from "@/lib/paste";
import { IconArrowUp, IconCheck, IconPaperclip, IconPlayerPlay } from "@tabler/icons-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { SessionSummary } from "@/lib/runtime/types";
import { AttachmentChips, useAttachments, useTauriDrop } from "./canvas-attachments";
import type { Attachment } from "./canvas-send";
import { matchSlash } from "./slash-commands";
import { isControlKey, keyToSequence } from "./terminal-keys";
import { useRuntime } from "@/lib/runtime/store";

interface Props {
  session: SessionSummary;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  send: (session: SessionSummary, text: string, attachments: Attachment[], onProgress: (id: string, fraction: number) => void) => Promise<boolean>;
}

/** Compact per-agent message bar; delivers through the same sendToTargets path as the bottom composer. */
export default function NodeMessageBar({ session, inputRef, send }: Props) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"idle" | "sending" | "sent">("idle");
  const [hover, setHover] = useState(false);
  const { client } = useRuntime();
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const attachments = useAttachments();
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sleeping = session.state !== "running" && session.state !== "starting";
  const setHoverStable = useCallback((value: boolean) => setHover(value), []);
  useTauriDrop(rootRef, attachments.add, setHoverStable);

  const slash = slashDismissed ? [] : matchSlash(session.provider, text);
  const slashOpen = slash.length > 0 && !(slash.length === 1 && text === "/" + slash[0].name);
  const completeSlash = (name: string) => { setText("/" + name + " "); setSlashDismissed(true); setSlashIndex(0); };

  useEffect(() => {
    const area = inputRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 88)}px`;
  }, [text, inputRef]);

  async function submit(override?: string) {
    const message = (override ?? text).trim();
    if (phase === "sending" || (!message && attachments.items.length === 0 && !sleeping)) return;
    setPhase("sending");
    attachments.resetProgress();
    const ok = await send(session, message, attachments.items, attachments.setFraction);
    if (ok) {
      setText("");
      attachments.clear();
      setPhase("sent");
      setTimeout(() => setPhase("idle"), 1200);
    } else setPhase("idle");
  }

  return (
    <div
      ref={rootRef}
      className={cn("canvas-node-message-bar nodrag nopan nowheel flex shrink-0 flex-col gap-1 border-t bg-transparent px-2 py-1.5 text-[12px] transition-colors", hover && "bg-primary/10")}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setHover(true); } }}
      onDragLeave={() => setHover(false)}
      onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); setHover(false); attachments.addFiles(Array.from(event.dataTransfer.files)); } }}
    >
      {slashOpen && (
        <ul role="listbox" aria-label="Slash commands" className="max-h-36 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
          {slash.map((command, index) => (
            <li key={command.name} role="option" aria-selected={index === slashIndex}>
              <button type="button" className={cn("flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left", index === slashIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/60")}
                onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSlashIndex(index)} onClick={() => { setSlashDismissed(true); setSlashIndex(0); void submit("/" + command.name); inputRef.current?.focus(); }}>
                <span className="font-mono font-medium">/{command.name}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{command.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <AttachmentChips small items={attachments.items} progress={attachments.progress} uploading={phase === "sending"} onRemove={attachments.remove} />
      <div className="flex items-end gap-1">
        <Button type="button" variant="ghost" size="icon-xs" className="size-6 shrink-0" aria-label="Attach files" title="Attach files" onClick={() => fileInput.current?.click()}><IconPaperclip size={13} /></Button>
        <input ref={fileInput} type="file" multiple hidden onChange={(event) => { attachments.addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={`Message ${session.title}…`}
          aria-label={`Message ${session.title}`}
          className="canvas-node-message-input max-h-22 min-h-6 min-w-0 flex-1 resize-none bg-transparent py-0.5 leading-5 outline-none px-1 placeholder:text-muted-foreground"
          onChange={(event) => { setText(event.target.value); setSlashDismissed(false); setSlashIndex(0); }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (slashOpen && !event.nativeEvent.isComposing) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSlashIndex((i) => (i + (event.key === "ArrowDown" ? 1 : slash.length - 1)) % slash.length); return; }
              // Tab fills the command in (to add arguments); Enter picks it and sends it right away, no second Enter.
              if (event.key === "Tab") { event.preventDefault(); completeSlash(slash[Math.min(slashIndex, slash.length - 1)].name); return; }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const name = slash[Math.min(slashIndex, slash.length - 1)].name;
                setSlashDismissed(true); setSlashIndex(0);
                void submit("/" + name);
                return;
              }
              if (event.key === "Escape") { event.preventDefault(); setSlashDismissed(true); return; }
            }
            // Empty bar on a running agent: control keys (Shift+Tab, Esc, arrows, Tab, Ctrl+C/O/R...) drive the agent's terminal.
            if (!sleeping && client && text === "" && attachments.items.length === 0 && !event.nativeEvent.isComposing && isControlKey(event)) {
              const data = keyToSequence(event);
              if (data !== null) { event.preventDefault(); void client.sendInput(session.id, data).catch(() => undefined); return; }
            }
            if (event.key === "Escape") event.currentTarget.blur();
            else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
          }}
          onPaste={(event) => {
            handlePaste(event.nativeEvent, attachments.addFiles, (item) => attachments.add([item]));
          }}
        />
        {sleeping ? (
          <Button type="button" size="xs" variant="secondary" className="shrink-0" disabled={phase === "sending"} onClick={() => void submit()}>
            {phase === "sending" ? <Spinner /> : <IconPlayerPlay size={12} />}
            Wake to send
          </Button>
        ) : (
          <Button type="button" size="icon-xs" className="size-6 shrink-0" aria-label="Send message" title="Send (Enter)" disabled={phase === "idle" && !text.trim() && attachments.items.length === 0} onClick={() => void submit()}>
            <span key={phase} className="animate-in zoom-in-50 fade-in motion-reduce:animate-none">
              {phase === "sending" ? <Spinner /> : phase === "sent" ? <IconCheck size={13} /> : <IconArrowUp size={13} />}
            </span>
          </Button>
        )}
      </div>
    </div>
  );
}
