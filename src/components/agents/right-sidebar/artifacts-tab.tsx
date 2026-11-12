import { useCallback, useEffect, useRef, useState } from "react";
import { IconDownload, IconPackage, IconRefresh } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { downloadWorkspacePath } from "@/lib/file-download";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";
import type { ArtifactListing } from "@/lib/runtime/workspace-files";
import FileDialog from "./files-tab-file-dialog";
import { FileIcon } from "./file-icons";
import { PanelEmpty, PanelError, RowSkeletons } from "./panel-states";

const REFRESH_MS = 10_000;

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function relativeTime(ms: number): string {
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 60) return "now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  return days < 30 ? `${Math.floor(days)}d ago` : `${Math.floor(days / 30)}mo ago`;
}

/** Files agents saved to the project's shared Artifacts folder, newest first. Click opens the viewer; the icon downloads. */
export default function ArtifactsTab({ client, sessionId, active }: { client: RuntimeClient; sessionId: string; active: boolean }) {
  const [listing, setListing] = useState<ArtifactListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(() => {
    const id = ++requestId.current;
    client.listArtifacts(sessionId)
      .then((result) => { if (id === requestId.current) { setListing(result); setError(null); } })
      .catch((cause) => { if (id === requestId.current) setError(errorMessage(cause)); });
  }, [client, sessionId]);

  useEffect(() => { setListing(null); setError(null); }, [sessionId]);
  // Only poll while the tab is visible: panels stay mounted when hidden.
  useEffect(() => {
    if (!active) return;
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="artifacts-tab">
      <div className="flex h-9 shrink-0 items-center gap-1 px-3">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={listing?.dir}>{listing?.dir ?? "Agent deliverables"}</span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Refresh artifacts" title="Refresh" onClick={load}><IconRefresh size={14} /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {error && !listing ? <PanelError message={error} onRetry={load} />
          : !listing ? <RowSkeletons count={6} />
          : listing.entries.length === 0 ? <PanelEmpty icon={<IconPackage />} title="No artifacts yet" hint="Files agents save here (reports, documents, images, exports) show up in this list." />
          : (
            <ul aria-label="Artifacts">
              {listing.entries.map((entry) => (
                <li key={entry.path} className="group flex items-center rounded-lg hover:bg-muted/55">
                  <button type="button" onClick={() => setOpenPath(entry.path)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <FileIcon name={entry.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-foreground" title={entry.path}>{entry.path}</span>
                      <span className="block text-[10px] text-muted-foreground tabular-nums">{formatSize(entry.size)} · {relativeTime(entry.modifiedAt)}</span>
                    </span>
                  </button>
                  <Button type="button" variant="ghost" size="icon-sm" className="mr-1 shrink-0 opacity-60 group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Download ${entry.name}`} title="Download" onClick={() => void downloadWorkspacePath(client, sessionId, entry.path, "file", entry.name, "artifacts")}><IconDownload size={14} /></Button>
                </li>
              ))}
            </ul>
          )}
      </div>
      {openPath && <FileDialog key={openPath} client={client} sessionId={sessionId} path={openPath} label="Artifacts" source="artifacts" onClose={() => setOpenPath(null)} />}
    </div>
  );
}
