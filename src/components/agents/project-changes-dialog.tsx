import { useEffect, useState } from "react";
import { IconGitCompare, IconRefresh } from "@tabler/icons-react";
import { AppDialog, ErrorBanner } from "@/components/ui/app-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "cn";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { GitChange, GitChanges, GitFileDiff } from "@/lib/runtime/git-review";
import { errorMessage } from "@/lib/runtime/store";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: RuntimeClient | null;
  sessionId: string;
  sessionTitle: string;
}

function statusLabel(change: GitChange): string {
  if (change.untracked) return "New";
  if (change.staged && change.unstaged) return "Staged + modified";
  if (change.staged) return "Staged";
  if (change.status.includes("D")) return "Deleted";
  if (change.status.includes("R")) return "Renamed";
  return "Modified";
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground";
  if (line.startsWith("+")) return "text-emerald-600 dark:text-emerald-400";
  if (line.startsWith("-")) return "text-destructive";
  if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) return "text-sky-700 dark:text-sky-300";
  return "text-foreground";
}

export default function ProjectChangesDialog({ open, onOpenChange, client, sessionId, sessionTitle }: Props) {
  const [summary, setSummary] = useState<GitChanges | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    if (!open || !client) return;
    let cancelled = false;
    setLoadingList(true);
    setError(null);
    setSummary(null);
    setDiff(null);
    setSelectedPath(null);
    void client.gitChanges(sessionId).then((result) => {
      if (cancelled) return;
      setSummary(result);
      setSelectedPath(result.changes[0]?.path ?? null);
    }).catch((cause) => {
      if (!cancelled) setError(errorMessage(cause));
    }).finally(() => {
      if (!cancelled) setLoadingList(false);
    });
    return () => { cancelled = true; };
  }, [open, client, sessionId, refreshVersion]);

  useEffect(() => {
    if (!open || !client || !selectedPath) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setLoadingDiff(true);
    setDiff(null);
    void client.gitDiff(sessionId, selectedPath).then((result) => {
      if (!cancelled) setDiff(result);
    }).catch((cause) => {
      if (!cancelled) setError(errorMessage(cause));
    }).finally(() => {
      if (!cancelled) setLoadingDiff(false);
    });
    return () => { cancelled = true; };
  }, [open, client, sessionId, selectedPath]);

  const refresh = () => {
    setError(null);
    setRefreshVersion((version) => version + 1);
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<IconGitCompare />}
      title="Project changes"
      description={`Read-only changes for ${sessionTitle}.`}
      size="lg"
      footerStart={summary && <span>{summary.branch ? `Branch ${summary.branch}` : "Detached HEAD"}</span>}
      footer={<Button type="button" variant="outline" size="sm" disabled={loadingList} onClick={refresh}>{loadingList ? <Spinner /> : <IconRefresh />}Refresh</Button>}
    >
      <div className="flex h-full min-h-0 flex-col gap-3">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {summary && (
          <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate font-medium text-foreground">{summary.repository}</span>
            <span className="shrink-0">{summary.changes.length}{summary.truncated ? "+" : ""} changed {summary.changes.length === 1 ? "file" : "files"}</span>
          </div>
        )}
        {loadingList && !summary ? (
          <div className="flex min-h-32 items-center justify-center"><Spinner /></div>
        ) : summary?.changes.length === 0 ? (
          <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">No uncommitted changes in this project.</div>
        ) : summary && (
          <>
            {summary.truncated && <p className="text-xs text-muted-foreground">Showing the first 1,000 files. Narrow the changes in your project to see the rest.</p>}
            <div aria-label="Changed files" className="max-h-36 shrink-0 overflow-auto rounded-lg border border-border">
              {summary.changes.map((change) => (
                <button
                  key={change.path}
                  type="button"
                  title={change.path}
                  aria-pressed={selectedPath === change.path}
                  onClick={() => setSelectedPath(change.path)}
                  className={cn("flex w-full min-w-0 items-center gap-2 border-b border-border/60 px-2.5 py-1.5 text-left text-xs last:border-b-0 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", selectedPath === change.path && "bg-muted")}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{change.path}</span>
                  <span className="shrink-0 text-muted-foreground">{statusLabel(change)}</span>
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-muted/30 p-2.5">
              {loadingDiff ? <div className="flex h-24 items-center justify-center"><Spinner /></div> : diff?.binary ? (
                <p className="text-xs text-muted-foreground">Binary file changed. Text preview is not available.</p>
              ) : diff?.tooLarge ? (
                <p className="text-xs text-muted-foreground">This file's diff is too large to preview here.</p>
              ) : diff?.patch ? (
                <pre aria-label={`Diff for ${diff.path}`} className="whitespace-pre font-mono text-[11px] leading-5">{diff.patch.split("\n").map((line, index) => <span key={index} className={cn("block", lineClass(line))}>{line || " "}</span>)}</pre>
              ) : selectedPath ? (
                <p className="text-xs text-muted-foreground">No text changes to display.</p>
              ) : (
                <p className="text-xs text-muted-foreground">Select a changed file to inspect its diff.</p>
              )}
            </div>
          </>
        )}
      </div>
    </AppDialog>
  );
}
