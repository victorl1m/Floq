import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import { subscribeConnect, subscribeFrames } from "@/lib/runtime/event-frames";
import type { ProjectAutomation, ProjectTask, ProjectTaskSettings } from "@/lib/project-tasks";

export interface ProjectTasksData {
  tasks: ProjectTask[];
  automations: ProjectAutomation[];
  settings: Record<string, ProjectTaskSettings>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  setTasks: (update: (tasks: ProjectTask[]) => ProjectTask[]) => void;
  setSettings: (update: (settings: Record<string, ProjectTaskSettings>) => Record<string, ProjectTaskSettings>) => void;
}

/** Tasks, automations and per-project agent switches for one project (or all). Refetches on 'tasks.changed' frames and on reconnect. */
export function useProjectTasks(projectId: string | null): ProjectTasksData {
  const { client } = useRuntime();
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [automations, setAutomations] = useState<ProjectAutomation[]>([]);
  const [settings, setSettings] = useState<Record<string, ProjectTaskSettings>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const scope = useRef(projectId);
  scope.current = projectId;

  const reload = useCallback(async () => {
    if (!client) return;
    const id = ++request.current;
    try {
      const [t, a] = await Promise.all([client.projectTasks(projectId ?? undefined), client.automations(projectId ?? undefined)]);
      if (id !== request.current) return;
      setTasks(t.tasks); setSettings(t.settings ?? {}); setAutomations(a); setError(null);
    } catch (e) {
      if (id === request.current) setError(errorMessage(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [client, projectId]);

  useEffect(() => { setLoading(true); void reload(); }, [reload]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void reload(), 150); };
    const off = subscribeFrames((frame) => {
      const f = frame as { type?: string; projectId?: string } | null;
      if (f?.type === "tasks.changed" && (!scope.current || !f.projectId || f.projectId === scope.current)) soon();
    });
    const offConnect = subscribeConnect(soon);
    return () => { off(); offConnect(); if (timer) clearTimeout(timer); };
  }, [reload]);

  return { tasks, automations, settings, loading, error, reload, setTasks, setSettings };
}
