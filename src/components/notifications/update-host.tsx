import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { installAndRestart, startUpdateScheduler, useUpdateState } from "@/lib/updater";
import { releaseNotesUrl } from "@/lib/updater-logic";
import { openExternal } from "@/lib/open-external";
import { markdownToHtml } from "@/lib/markdown-lite";

const TOAST_ID = "app-update-ready";

/** The release notes as shown to the user: the "Tests" and "Deployment" sections are for maintainers, so they are left out. */
function userNotes(notes: string): string {
  return notes.split(/\n(?=## )/).filter((part) => !/^## (Tests|Deployment)\b/.test(part.trim())).join("\n").replace(/^# Release v[\d.]+\s*/, "").trim();
}

/** Headless: starts the update scheduler, shows "Floq X is ready" once the update is downloaded, and the changelog on request. */
export function UpdateHost() {
  const update = useUpdateState();
  const announced = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (update.notes ? markdownToHtml(userNotes(update.notes)) : ""), [update.notes]);

  useEffect(() => startUpdateScheduler(), []);

  useEffect(() => {
    if (update.status !== "ready" || !update.version || announced.current === update.version) return;
    announced.current = update.version;
    const version = update.version;
    toast.success(`Floq ${version} is ready`, {
      id: TOAST_ID,
      description: (
        <span>
          Restart to finish updating.{" "}
          <button type="button" className="underline underline-offset-2" onClick={() => (update.notes ? setOpen(true) : void openExternal(releaseNotesUrl(version)))}>
            What's new
          </button>
        </span>
      ),
      duration: Infinity,
      action: { label: "Restart now", onClick: () => void installAndRestart() },
      cancel: { label: "Later", onClick: () => undefined },
      closeButton: false,
    });
  }, [update.status, update.version, update.notes]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>What's new in Floq {update.version}</DialogTitle>
          <DialogDescription>Downloaded and ready. Restart to start using it.</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[55vh] pr-3">
          {/* markdownToHtml escapes all input and only emits a fixed set of tags (see markdown-lite.ts). */}
          <div className="prose-sm space-y-2 text-sm leading-relaxed [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_strong]:text-foreground text-muted-foreground" dangerouslySetInnerHTML={{ __html: html }} />
        </ScrollArea>
        <DialogFooter>
          <Button variant="ghost" onClick={() => void openExternal(releaseNotesUrl(update.version ?? ""))}>Open on GitHub</Button>
          <Button variant="outline" onClick={() => setOpen(false)}>Later</Button>
          <Button onClick={() => void installAndRestart()}>Restart now</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
