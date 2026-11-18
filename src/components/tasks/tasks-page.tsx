import { useEffect, useMemo, useState } from "react";
import { IconBolt, IconChecklist, IconClockPlay, IconLayoutKanban } from "@tabler/icons-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import { isOrchestrator } from "@/lib/runtime/orchestrator";
import BoardsView from "./boards-view";
import TasksTab from "./tasks-tab";
import AutomationsTab from "./automations-tab";
import { projectAgents } from "./task-agents";
import { useProjectTasks } from "./use-project-tasks";

type TabId = "tasks" | "automations" | "boards";
const STORE = "floq.tasks.screen.v1";
const ALL = "all";

function readPrefs(): { project: string; tab: TabId } {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "null") as { project?: string; tab?: string } | null;
    return { project: typeof v?.project === "string" ? v.project : ALL, tab: v?.tab === "automations" || v?.tab === "boards" ? v.tab : "tasks" };
  } catch { return { project: ALL, tab: "tasks" }; }
}

export default function TasksPage() {
  const { client, projects, sessions } = useRuntime();
  const [prefs, setPrefs] = useState(readPrefs);
  const projectId = prefs.project !== ALL && projects.some((p) => p.id === prefs.project) ? prefs.project : null;
  const data = useProjectTasks(projectId);
  const [savingSwitch, setSavingSwitch] = useState(false);
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch { /* optional */ } }, [prefs]);

  const agents = useMemo(() => projectAgents(sessions, projectId), [sessions, projectId]);
  const settings = projectId ? data.settings[projectId] : undefined;
  const lead = agents.find(isOrchestrator) ?? agents[0];
  const target = agents.find((a) => a.id === settings?.agentSessionId) ?? lead;
  const label = (id: string) => { const p = projects.find((x) => x.id === id); return p?.displayName?.trim() || p?.name || "Project"; };

  const saveSettings = async (autoAgent: boolean, agentSessionId: string | null) => {
    if (!client || !projectId) return;
    const previous = data.settings;
    data.setSettings((s) => ({ ...s, [projectId]: { autoAgent, agentSessionId } }));
    setSavingSwitch(true);
    try { await client.saveProjectTaskSettings(projectId, { autoAgent, agentSessionId }); }
    catch (e) { data.setSettings(() => previous); toast.error(errorMessage(e)); }
    finally { setSavingSwitch(false); }
  };

  const autoOn = settings?.autoAgent ?? false;
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col text-foreground">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <IconChecklist className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className="truncate text-base font-semibold">Tasks &amp; Automations</h1>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">Project</span>
          <NativeSelect aria-label="Project" value={projectId ?? ALL} onChange={(e) => setPrefs((p) => ({ ...p, project: e.target.value }))} className="w-auto max-w-56">
            <NativeSelectOption value={ALL}>All projects</NativeSelectOption>
            {projects.map((p) => <NativeSelectOption key={p.id} value={p.id}>{label(p.id)}</NativeSelectOption>)}
          </NativeSelect>
        </label>
        <div className="ml-auto flex min-w-0 max-w-full items-center gap-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-1.5 glass-surface">
          <IconBolt className={`size-4 shrink-0 ${autoOn ? "text-amber-500" : "text-muted-foreground"}`} aria-hidden />
          <div className="min-w-0 text-xs leading-tight">
            <div className="font-medium text-sm" id="auto-agent-label">Agents work on tasks</div>
            <div className="truncate text-muted-foreground" id="auto-agent-hint">
              {!projectId ? "Pick a project to turn this on." : autoOn ? `On: ${target ? target.title : "no agent yet"} gets new tasks.` : "Off: tasks wait for you."}
            </div>
          </div>
          {projectId && agents.length > 0 && <NativeSelect aria-label="Agent that receives tasks" value={target?.id ?? ""} disabled={savingSwitch} className="hidden w-auto max-w-40 sm:block"
            onChange={(e) => void saveSettings(autoOn, e.target.value === lead?.id ? null : e.target.value)}>
            {agents.map((a) => <NativeSelectOption key={a.id} value={a.id}>{a.title}{isOrchestrator(a) ? " (orchestrator)" : ""}</NativeSelectOption>)}
          </NativeSelect>}
          <Tooltip><TooltipTrigger asChild><span>
            <Switch checked={autoOn} disabled={!projectId || savingSwitch} aria-labelledby="auto-agent-label" aria-describedby="auto-agent-hint" onCheckedChange={(v) => void saveSettings(v, settings?.agentSessionId ?? null)} />
          </span></TooltipTrigger><TooltipContent>{projectId ? "When on, To do tasks are sent to the agent automatically (on their Run on date, if set)." : "Choose a project first."}</TooltipContent></Tooltip>
        </div>
      </header>
      <Tabs value={prefs.tab} onValueChange={(v) => setPrefs((p) => ({ ...p, tab: v as TabId }))} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="shrink-0 border-b px-3 py-1.5 sm:px-5">
          <TabsList>
            <TabsTrigger value="tasks"><IconChecklist />Tasks</TabsTrigger>
            <TabsTrigger value="automations"><IconClockPlay />Automations</TabsTrigger>
            <TabsTrigger value="boards"><IconLayoutKanban />Boards</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="tasks" className="flex min-h-0 flex-1 flex-col"><TasksTab data={data} projectId={projectId} projectLabel={label} autoOn={autoOn} target={target?.title ?? null} /></TabsContent>
        <TabsContent value="automations" className="flex min-h-0 flex-1 flex-col"><AutomationsTab data={data} projectId={projectId} projectLabel={label} /></TabsContent>
        <TabsContent value="boards" className="flex min-h-0 flex-1 flex-col"><BoardsView /></TabsContent>
      </Tabs>
    </section>
  );
}
