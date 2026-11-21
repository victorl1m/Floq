import { useCallback, useEffect, useState } from "react";
import { IconEye, IconTrash } from "@tabler/icons-react";
import { Badge, Button, PluginState, toast, usePluginApi, usePluginEvent } from "@/plugins/kit";
import { defineUiPlugin } from "@/plugins/sdk";

interface Entry { category: string; label: string; action: "removed" | "would-remove" | "kept" | "failed"; reason: string; detail: string; bytes?: number; attention?: boolean }
interface Report { at: string; dryRun: boolean; trigger: string; durationMs: number; partial: boolean; freedBytes: number; counts: { removed: number; kept: number; failed: number; attention: number }; entries: Entry[] }
export interface StorageSenseState { mode: "off" | "report" | "clean"; awake: boolean; freePercent: number | null; lastRunAt: number | null; report: Report | null }

const CATEGORY: Record<string, string> = { worktree: "Worktrees", branch: "Branches", scratchpad: "Scratchpads", build: "Build output", attachment: "Attachments", tmp: "Temp files" };
const MODE: Record<StorageSenseState["mode"], string> = { off: "Off", report: "Report only", clean: "Cleaning automatically" };

export function size(n?: number): string {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Storage Sense panel (footer popover): when it last ran, what it removed, and what it kept and why. Thresholds and notifications live in Settings > Plugins. */
export function StorageSensePanel({ pluginId, onState }: { pluginId: string; onState?: (state: StorageSenseState) => void }) {
  const api = usePluginApi(pluginId);
  const [state, setState] = useState<StorageSenseState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "clean" | null>(null);

  const load = useCallback(async () => {
    try { setFailed(null); const next = await api<StorageSenseState>("/state"); setState(next); onState?.(next); }
    catch (error) { setFailed(error instanceof Error ? error.message : "Request failed"); }
  }, [api, onState]);
  useEffect(() => { void load(); }, [load]);
  usePluginEvent(pluginId, "report", () => { void load(); });

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? "preview" : "clean");
    try {
      const report = await api<Report>("/run", { method: "POST", body: { dryRun } });
      toast.success(dryRun ? `Preview: ${report.counts.removed} item(s) could be removed` : `Removed ${report.counts.removed} item(s)`);
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not run"); }
    finally { setBusy(null); }
  };

  const report = state?.report ?? null;
  const groups = report ? Object.entries(CATEGORY).map(([key, label]) => ({ label, entries: report.entries.filter((e) => e.category === key) })).filter((g) => g.entries.length) : [];
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">Storage Sense</div>
          <p className="text-xs text-muted-foreground">Removes merged worktrees, orphan branches, old scratchpads, uploads and temp files. Never touches Artifacts, transcripts or unsaved work.</p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy !== null || !state?.awake} onClick={() => void run(true)}><IconEye /> Preview</Button>
        <Button size="sm" disabled={busy !== null || !state?.awake || state?.mode === "off"} onClick={() => void run(false)}><IconTrash /> Clean now</Button>
      </div>
      {failed ? <PluginState state="error" description={failed} onRetry={() => void load()} />
        : !state ? <PluginState state="loading" />
        : <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Mode: <span className="text-foreground">{MODE[state.mode]}</span>
            {state.freePercent !== null && <> · {state.freePercent}% free</>}
            {state.lastRunAt && <> · last run {new Date(state.lastRunAt).toLocaleString()}</>}
            {!state.awake && <> · your workspace is asleep; cleanup runs while it is awake</>}
          </p>
          {!report && state.lastRunAt ? <PluginState state="empty" title={`Last run ${new Date(state.lastRunAt).toLocaleString()}: nothing to remove`} description="Storage Sense ran and found nothing to clean up." />
            : !report ? <PluginState state="empty" title="No report yet" description="Press Preview to see what Storage Sense would remove. Nothing is deleted by a preview." />
            : <div className="space-y-4">
              <p className="text-sm">
                {report.dryRun ? "Preview" : "Run"} ({report.trigger}): {report.counts.removed === 0 && report.counts.kept === 0 && report.counts.failed === 0 ? <>nothing to remove</> : <>{report.dryRun ? "could remove" : "removed"} <b>{report.counts.removed}</b>{report.freedBytes ? <> ({size(report.freedBytes)})</> : null}, kept {report.counts.kept}</>}
                {report.counts.failed ? <>, {report.counts.failed} failed</> : null}{report.partial ? " · stopped at its time limit, continues next run" : ""}
              </p>
              {groups.map((g) => (
                <section key={g.label} className="space-y-1">
                  <h3 className="text-sm font-medium">{g.label}</h3>
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {g.entries.map((e) => (
                      <li key={e.category + e.label} className="flex items-start gap-3 px-3 py-2 text-[13px]">
                        <Badge variant={e.attention ? "destructive" : e.action === "kept" ? "secondary" : "outline"}>{e.action === "would-remove" ? "would remove" : e.action}</Badge>
                        <div className="min-w-0 flex-1"><div className="truncate font-mono text-xs">{e.label}</div><div className="text-muted-foreground">{e.detail}</div></div>
                        <span className="text-xs text-muted-foreground">{size(e.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>}
        </div>}
    </div>
  );
}

// No views: Storage Sense lives in the footer (src/components/window/storage-sense-footer.tsx).
export default defineUiPlugin({});
