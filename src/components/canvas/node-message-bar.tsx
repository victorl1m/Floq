import { useCallback, useEffect, useRef, useState } from "react";
import { IconArrowUp, IconCheck, IconPaperclip, IconPlayerPlay } from "@tabler/icons-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ActivityIndicator } from "@/components/agents/activity-indicator";
import type { SessionSummary } from "@/lib/runtime/types";
import { AttachmentChips, pastedFiles, pastedTauriImage, useAttachments, useTauriDrop } from "./canvas-attachments";
import type { Attachment } from "./canvas-send";

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
  const attachments = useAttachments();
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sleeping = session.state !== "running" && session.state !== "starting";
  const setHoverStable = useCallback((value: boolean) => setHover(value), []);
  useTauriDrop(rootRef, attachments.add, setHoverStable);

  useEffect(() => {
    const area = inputRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 88)}px`;
  }, [text, inputRef]);

  async function submit() {
    if (phase === "sending" || (!text.trim() && attachments.items.length === 0 && !sleeping)) return;
    setPhase("sending");
    attachments.resetProgress();
    const ok = await send(session, text.trim(), attachments.items, attachments.setFraction);
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
      className={cn("canvas-node-message-bar nodrag nopan nowheel flex shrink-0 flex-col gap-1 border-t bg-muted/30 px-2 py-1.5 text-[12px] transition-colors", hover && "bg-primary/10")}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setHover(true); } }}
      onDragLeave={() => setHover(false)}
      onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); setHover(false); attachments.addFiles(Array.from(event.dataTransfer.files)); } }}
    >
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
          className="canvas-node-message-input max-h-22 min-h-6 min-w-0 flex-1 resize-none bg-transparent py-0.5 leading-5 outline-none placeholder:text-muted-foreground/70"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") event.currentTarget.blur();
            else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
          }}
          onPaste={(event) => {
            const files = pastedFiles(event.nativeEvent);
            if (files) { event.preventDefault(); attachments.addFiles(files); return; }
            if (!event.clipboardData.getData("text/plain")) void pastedTauriImage().then((items) => items.length && attachments.add(items));
          }}
        />
        <ActivityIndicator session={session} className="mb-2" />
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
