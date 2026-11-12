// Test harness: the real canvas toolbar button + Changes dialog body against a fake client; the sidebar tab strip is checked via its tab list.
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { IconGitCompare, IconX } from "@tabler/icons-react";
import { CanvasTitlebarToolbar } from "@/components/canvas/canvas-titlebar-toolbar";
import ChangesTab from "@/components/agents/right-sidebar/changes-tab";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { openChangesDialog, setChangesCount, setChangesDialogOpen, useChangesDialog } from "@/lib/changes-dialog";
import { CORE_TABS, resolveRightSidebarTab } from "@/lib/right-sidebar";

const n = Number(new URLSearchParams(location.search).get("n") ?? 120);
const changes = Array.from({ length: n }, (_, i) => ({ path: `src/file-${i}.ts`, status: "M", staged: false, unstaged: true, untracked: false }));
const client = {
  async gitChanges() { return { repository: "r", branch: "main", changes, truncated: false }; },
  async gitDiff(_s: string, path: string) { return { path, patch: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`, binary: false, tooLarge: false }; },
} as never;
const targets = [{ id: "w", label: "main", branch: "main", sessionId: "s" }];
setChangesCount(n);
(window as unknown as { __tabs: unknown }).__tabs = { core: CORE_TABS, resolvedChanges: resolveRightSidebarTab("changes" as never, []) };

function App() {
  const { open, count } = useChangesDialog();
  const noop = () => {};
  return (
    <TooltipProvider>
      <div style={{ height: 40 }}>
        <CanvasTitlebarToolbar project={{} as never} projectKey="p" name="Proj" sleepingCount={0} onWakeAll={noop} tool="select" onTool={noop} linkActive={false} onToggleLink={noop} onAddNote={noop} onAddKeychain={noop} onRelayout={noop} onShowNotes={noop} onFit={noop} onOpenChanges={openChangesDialog} changeCount={count} branch="feature/very-long-branch-name-here" activityOpen={false} onToggleActivity={noop} onKeyDown={noop} />
      </div>
      <Dialog open={open} onOpenChange={setChangesDialogOpen}>
        <DialogContent showCloseButton={false} className="flex h-[min(860px,90vh)] w-[min(1100px,94vw)] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none">
          <div className="flex h-12 items-center gap-2 border-b px-3"><IconGitCompare className="size-4" /><DialogTitle className="flex-1 text-sm">Changes</DialogTitle><DialogDescription className="sr-only">d</DialogDescription><Button size="icon-sm" variant="ghost" aria-label="Close" onClick={() => setChangesDialogOpen(false)}><IconX size={16} /></Button></div>
          <div className="min-h-0 flex-1"><ChangesTab client={client} targets={targets} onCount={setChangesCount} /></div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
