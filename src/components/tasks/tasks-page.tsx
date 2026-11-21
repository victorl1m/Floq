import { useEffect, useMemo, useState } from "react";
import { IconBolt, IconCheck, IconChecklist, IconChevronDown, IconClockPlay, IconLayoutKanban, IconStack2 } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ProjectMark } from "@/components/projects/project-identity";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import { isOrchestrator } from "@/lib/runtime/orchestrator";
import { cn } from "cn";
import BoardsView from "./boards-view";
import TasksTab from "./tasks-tab";
import AutomationsTab from "./automations-tab";
import { projectAgents } from "./task-agents";
import { useProjectTasks } from "./use-project-tasks";
import "./tasks.css";

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
  const selected = projectId ? projects.find((p) => p.id === projectId) : undefined;

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
  const hint = !projectId
    ? "Choose a project to let its agent pick up tasks."
    : agents.length === 0
      ? "This project has no agents yet. Start one from Home or the canvas."
      : autoOn
        ? "To do tasks go to this agent as soon as they are added, or on their Run on date."
        : "Off: tasks wait in To do until you send them.";

  return (
    <section className="tasks-root relative flex h-full min-h-0 min-w-0 flex-col text-foreground">
      <div aria-hidden="true" className="tasks-backdrop" />
      <Tabs value={prefs.tab} onValueChange={(v) => setPrefs((p) => ({ ...p, tab: v as TabId }))} className="flex min-h-0 flex-1 flex-col gap-0">
        <header className="flex shrink-0 flex-col gap-5 px-4 pt-7 pb-4 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
            <div className="flex min-w-0 flex-col gap-1.5">
              <h1 className="page-heading font-semibold tracking-tight">Tasks &amp; Automations</h1>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="-ml-2 text-foreground" aria-label={`Project: ${selected ? label(selected.id) : "All projects"}`}>
                      {selected ? <ProjectMark project={selected} /> : <IconStack2 />}
                      <span className="max-w-52 truncate">{selected ? label(selected.id) : "All projects"}</span>
                      <IconChevronDown className="size-3 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-max max-w-[340px] min-w-[240px]">
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Show tasks from</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={() => setPrefs((p) => ({ ...p, project: ALL }))}>
                      <IconStack2 />All projects{!projectId && <IconCheck className="ml-auto" />}
                    </DropdownMenuItem>
                    {projects.length > 0 && <DropdownMenuSeparator />}
                    {projects.map((p) => (
                      <DropdownMenuItem key={p.id} onSelect={() => setPrefs((s) => ({ ...s, project: p.id }))}>
                        <ProjectMark project={p} /><span className="truncate">{label(p.id)}</span>{p.id === projectId && <IconCheck className="ml-auto" />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <span className="hidden sm:inline">Plan work for your agents and schedule the work that repeats.</span>
              </div>
            </div>

            {/* The hand-off switch: reads like a Settings row. */}
            <div className="settings-group w-full min-w-0 md:w-auto md:max-w-[34rem]">
              <div className="flex items-center gap-3 px-4! py-3!">
                <span aria-hidden className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors", autoOn ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-muted text-muted-foreground")}>
                  <IconBolt className="size-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium" id="auto-agent-label">Agents work on tasks</div>
                  <p className="text-xs leading-snug text-muted-foreground" id="auto-agent-hint">{hint}</p>
                </div>
                {projectId && agents.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="outline" size="sm" disabled={savingSwitch} className="max-w-44 shrink-0" aria-label={`Agent that receives tasks: ${target?.title ?? "none"}`}>
                        {target && <AgentAvatar session={target} size={16} />}
                        <span className="hidden truncate sm:inline">{target?.title ?? "Choose agent"}</span>
                        <IconChevronDown className="size-3 text-muted-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-max max-w-[320px] min-w-[220px]">
                      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Send tasks to</DropdownMenuLabel>
                      {agents.map((a) => (
                        <DropdownMenuItem key={a.id} onSelect={() => void saveSettings(autoOn, a.id === lead?.id ? null : a.id)}>
                          <AgentAvatar session={a} size={18} />
                          <span className="truncate">{a.title}</span>
                          {isOrchestrator(a) && <span className="text-xs text-muted-foreground">Orchestrator</span>}
                          {a.id === target?.id && <IconCheck className="ml-auto" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Switch checked={autoOn} disabled={!projectId || savingSwitch} aria-labelledby="auto-agent-label" aria-describedby="auto-agent-hint" onCheckedChange={(v) => void saveSettings(v, settings?.agentSessionId ?? null)} />
              </div>
            </div>
          </div>

          <TabsList className="h-9! self-start">
            <TabsTrigger value="tasks" className="px-3"><IconChecklist />Tasks</TabsTrigger>
            <TabsTrigger value="automations" className="px-3"><IconClockPlay />Automations</TabsTrigger>
            <TabsTrigger value="boards" className="px-3"><IconLayoutKanban />Boards</TabsTrigger>
          </TabsList>
        </header>
        <TabsContent value="tasks" className="flex min-h-0 flex-1 flex-col"><TasksTab data={data} projectId={projectId} projectLabel={label} autoOn={autoOn} target={target?.title ?? null} /></TabsContent>
        <TabsContent value="automations" className="flex min-h-0 flex-1 flex-col"><AutomationsTab data={data} projectId={projectId} projectLabel={label} /></TabsContent>
        <TabsContent value="boards" className="flex min-h-0 flex-1 flex-col border-t"><BoardsView /></TabsContent>
      </Tabs>
    </section>
  );
}
