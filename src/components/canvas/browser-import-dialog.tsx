// "Import cookies & data" for the agent browser (docs/design/agent-browser.md §A.13): pick a file the user exported
// themselves, preview domains and counts, choose per domain, then import into the shared browser profile.
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { BrowserImportPreview } from "@/lib/runtime/browser-types";
import { errorMessage } from "@/lib/runtime/store";

const MAX_BYTES = 5 * 1024 * 1024;

export function BrowserImportDialog({ client, open, onOpenChange, onDone }: { client: RuntimeClient; open: boolean; onOpenChange: (open: boolean) => void; onDone?: () => void }) {
  const [preview, setPreview] = useState<BrowserImportPreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bookmarks, setBookmarks] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => { setPreview(null); setPicked(new Set()); setBookmarks(true); setError(null); setBusy(false); if (fileRef.current) fileRef.current.value = ""; };
  const close = (o: boolean) => { if (!o) reset(); onOpenChange(o); };

  async function choose(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_BYTES) return setError("That file is too large (limit 5 MB).");
    setBusy(true);
    try {
      const p = await client.browserImportPreview(await file.text());
      setPreview(p);
      setPicked(new Set(p.cookies.domains.map((d) => d.domain)));
      setBookmarks(p.bookmarks.count > 0);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await client.browserImportCommit(preview.importId, [...picked], bookmarks && preview.bookmarks.count > 0);
      toast.success(`Imported ${r.imported} cookie${r.imported === 1 ? "" : "s"}${r.bookmarks ? ` and ${r.bookmarks} bookmarks` : ""}`, r.failed ? { description: `${r.failed} could not be applied.` } : undefined);
      onDone?.();
      close(false);
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }

  const toggle = (d: string, on: boolean) => setPicked((s) => { const n = new Set(s); if (on) n.add(d); else n.delete(d); return n; });
  const nothing = picked.size === 0 && !(bookmarks && (preview?.bookmarks.count ?? 0) > 0);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent data-testid="browser-import-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import cookies &amp; data</DialogTitle>
          <DialogDescription>Choose a file you exported yourself: cookies.txt (Netscape), a JSON cookie export, or a bookmarks HTML file. Floq never reads your local browsers.</DialogDescription>
        </DialogHeader>
        {!preview ? (
          <div className="flex flex-col gap-2">
            <input ref={fileRef} data-testid="browser-import-file" type="file" aria-label="Cookie or bookmarks file" accept=".txt,.json,.html,.htm,text/plain,application/json,text/html" disabled={busy}
              className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1 file:text-xs" onChange={(e) => void choose(e.target.files?.[0])} />
            {busy && <p role="status" className="text-xs text-muted-foreground">Reading file…</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {preview.cookies.total > 0 && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{preview.cookies.total} cookies on {preview.cookies.domains.length} domains
                  {preview.cookies.expired ? ` · ${preview.cookies.expired} expired skipped` : ""}{preview.cookies.malformed ? ` · ${preview.cookies.malformed} unreadable skipped` : ""}</p>
                <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                  {preview.cookies.domains.map((d) => (
                    <label key={d.domain} className="flex cursor-pointer items-center gap-2 border-b border-border/50 px-2 py-1.5 text-sm last:border-b-0">
                      <Checkbox data-testid="import-domain" aria-label={`Import ${d.domain}`} checked={picked.has(d.domain)} onCheckedChange={(v) => toggle(d.domain, v === true)} />
                      <span className="min-w-0 flex-1 truncate">{d.domain}</span>
                      <span className="text-xs text-muted-foreground">{d.count}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {preview.bookmarks.count > 0 && (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox aria-label="Import bookmarks" checked={bookmarks} onCheckedChange={(v) => setBookmarks(v === true)} />
                Bookmarks ({preview.bookmarks.count})
              </label>
            )}
            {preview.skippedStorage && <p className="text-xs text-muted-foreground">localStorage in this file is not imported; only cookies.</p>}
            <p data-testid="import-warning" role="note" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
              Agents will act as you on these sites. Anything you import here can be used by every agent of yours, in all projects. Only import sites you are comfortable letting agents use.
            </p>
          </div>
        )}
        {error && <p role="alert" data-testid="import-error" className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
          {preview && <Button data-testid="import-commit" disabled={busy || nothing} onClick={() => void commit()}>{busy ? "Importing…" : "Import"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
