// "Export chat" (one chat) and "Export all chats" (the account): what goes in the file, then the runtime streams it and the app saves it.
import { useEffect, useState } from "react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Switch, usePluginDownload } from "@/plugins/kit";
import { chatTitle, type Chat } from "@whatsapp-shared/chat";
import { useWa } from "./context";
import { IconDownload } from "./icons-session";

type Transcript = "none" | "html" | "md";
const FORMATS: Array<[Transcript, string]> = [["none", "None"], ["html", "HTML"], ["md", "Markdown"]];
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100);

/** chat: the chat to export; left out, every chat of the account (a zip with one folder per chat). */
export function ExportDialog({ open, onOpenChange, chat }: { open: boolean; onOpenChange: (o: boolean) => void; chat?: Chat }) {
  const { pluginId, session, me } = useWa();
  const download = usePluginDownload(pluginId);
  const [media, setMedia] = useState(false);
  const [transcript, setTranscript] = useState<Transcript>("none");
  const [originals, setOriginals] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setMedia(false); setTranscript("none"); setOriginals(false); setBusy(false); } }, [open]);
  const title = chat ? chatTitle(chat).replace(/ \(You\)$/, "") : "";
  const zipped = !chat || media || transcript !== "none";
  async function start() {
    setBusy(true);
    const query: Record<string, string> = { ...(session ? { session } : {}), ...(chat ? { chatId: chat.chatId, name: title } : { all: "1" }), locale: navigator.language || "en-GB", tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
    if (media) query.media = "1";
    if (transcript !== "none") query.transcript = transcript;
    if (originals) query.originals = "1";
    const name = chat ? `WhatsApp Chat - ${clean(title) || "chat"}.${zipped ? "zip" : "txt"}` : `WhatsApp Chats - ${clean(me?.name || "account") || "account"}.zip`;
    const started = await download("/export", query, name);
    setBusy(false);
    if (started) onOpenChange(false);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="wa-dialog">
        <div className="wa-dlg wa-exp">
          <DialogHeader>
            <DialogTitle>{chat ? "Export chat" : "Export all chats"}</DialogTitle>
            <DialogDescription>{chat ? `Save “${title}” as a WhatsApp chat export (a .txt file).` : "One zip with a folder per chat, each in WhatsApp's export format."}</DialogDescription>
          </DialogHeader>
          <div className="wa-switches">
            <label className="wa-switch"><span><b>Include media</b><small>Photos, videos, voice messages, stickers and documents Floq has. Files it does not have are listed as unavailable.</small></span>
              <Switch checked={media} onCheckedChange={setMedia} aria-label="Include media" /></label>
            <label className="wa-switch"><span><b>Include originals of deleted messages</b><small>Only for messages Floq kept before they were deleted.</small></span>
              <Switch checked={originals} onCheckedChange={setOriginals} aria-label="Include originals of deleted messages" /></label>
          </div>
          <div className="wa-exp-field" role="group" aria-label="Readable transcript">
            <b>Readable transcript</b><small>An extra page to read the chat in, next to the .txt.</small>
            <div className="wa-seg">{FORMATS.map(([id, label]) => <button key={id} type="button" aria-pressed={transcript === id} onClick={() => setTranscript(id)}>{label}</button>)}</div>
          </div>
          <p className="wa-fine wa-exp-note">{zipped ? "You get a .zip file." : "You get a .txt file."} The chat is read from Floq only: nothing is downloaded from WhatsApp.</p>
          <DialogFooter className="wa-dlg-foot">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="button" disabled={busy} onClick={() => void start()}><IconDownload />{busy ? "Preparing…" : "Export"}</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
