import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconChevronRight, IconDownload, IconPackage, IconRefresh, IconSearch, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { groupArtifacts } from "@/lib/artifact-groups";
import { downloadWorkspacePath } from "@/lib/file-download";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";
import type { ArtifactListing } from "@/lib/runtime/workspace-files";
import { cn } from "@/lib/utils";
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

/**
 * Files agents saved to the project's shared Artifacts folder, grouped under one header per day (newest first).
 * Day headers always start collapsed; a search opens every day with a match and clearing it collapses them again.
 * Click opens the viewer; the icon downloads.
 */
export default function ArtifactsTab({ client, sessionId, active }: { client: RuntimeClient; sessionId: string; active: boolean }) {
  const [listing, setListing] = useState<ArtifactListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Days the user opened while browsing, and days the user closed while searching. Neither survives a remount.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [closedInSearch, setClosedInSearch] = useState<ReadonlySet<string>>(() => new Set());
  const requestId = useRef(0);

  const load = useCallback(() => {
    const id = ++requestId.current;
    client.listArtifacts(sessionId)
      .then((result) => { if (id === requestId.current) { setListing(result); setError(null); } })
      .catch((cause) => { if (id === requestId.current) setError(errorMessage(cause)); });
  }, [client, sessionId]);

  useEffect(() => { setListing(null); setError(null); setQuery(""); setExpanded(new Set()); }, [sessionId]);
  useEffect(() => { setClosedInSearch(new Set()); }, [query]);
  // Only poll while the tab is visible: panels stay mounted when hidden.
  useEffect(() => {
    if (!active) return;
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const searching = query.trim().length > 0;
  const groups = useMemo(() => (listing ? groupArtifacts(listing.entries, query) : []), [listing, query]);
  const isOpen = (key: string) => (searching ? !closedInSearch.has(key) : expanded.has(key));
  const toggle = (key: string) => {
    const flip = (set: ReadonlySet<string>) => { const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); return next; };
    if (searching) setClosedInSearch(flip); else setExpanded(flip);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="artifacts-tab">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/70 bg-background/20 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <IconSearch aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search artifacts" placeholder="Search artifacts" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} className="h-7 pr-6 pl-7 text-xs" />
          {query && <Button variant="ghost" size="icon-xs" type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute inset-y-0 right-1.5 my-auto size-5 text-muted-foreground"><IconX className="size-3" /></Button>}
        </div>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Refresh artifacts" title="Refresh" onClick={load}><IconRefresh /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {error && !listing ? <PanelError message={error} onRetry={load} />
          : !listing ? <RowSkeletons count={6} />
          : listing.entries.length === 0 ? <PanelEmpty icon={<IconPackage />} title="No artifacts yet" hint="Files agents save here (reports, documents, images, exports) show up in this list." />
          : groups.length === 0 ? <PanelEmpty icon={<IconSearch />} title="No matching artifacts" hint="Try another file name or folder." />
          : (
            <div role="list" aria-label="Artifacts">
              {groups.map((group) => {
                const open = isOpen(group.key);
                const bodyId = `artifacts-day-${group.key}`;
                return (
                  <section key={group.key} role="listitem" aria-label={group.label}>
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={bodyId}
                      onClick={() => toggle(group.key)}
                      className="floq-sticky-head sticky top-0 z-[1] flex h-7 w-full items-center gap-1.5 px-3 text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      <IconChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
                      <span className="min-w-0 flex-1 truncate">{group.label}</span>
                      <span className="shrink-0 tabular-nums">{group.entries.length}</span>
                    </button>
                    {open && (
                      <ul id={bodyId} aria-label={`Artifacts from ${group.label}`} className="px-1.5">
                        {group.entries.map((entry) => (
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
                  </section>
                );
              })}
            </div>
          )}
      </div>
      {listing?.dir && <div className="shrink-0 truncate border-t border-border/70 px-3 py-1.5 text-[10px] text-muted-foreground" title={listing.dir}>{listing.dir}</div>}
      {openPath && <FileDialog key={openPath} client={client} sessionId={sessionId} path={openPath} label="Artifacts" source="artifacts" onClose={() => setOpenPath(null)} />}
    </div>
  );
}
