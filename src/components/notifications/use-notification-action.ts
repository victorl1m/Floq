import { useCallback } from "react";
import { useRuntime } from "@/lib/runtime/store";
import { openExternal } from "@/lib/open-external";
import type { AppNotification } from "@/lib/notifications";
import { deliverPluginOpen } from "@/plugins/sdk";

/** Runs a notification's one-click deep link. url: browser; canvas/agent: focus the node/session; settings: that section. */
export function useNotificationAction() {
  const { sessions, projects, activeProjectId, focusOnCanvas, openSession, openCanvas, openSettings, navigate } = useRuntime();
  return useCallback((n: Pick<AppNotification, "action" | "projectId" | "plugin">) => {
    // A plugin notification opens that plugin's own view, at the place it named (a chat).
    const target = n.plugin?.target;
    if (n.plugin && target) { deliverPluginOpen(n.plugin.id, target.view, target.params); navigate("plugin", `${n.plugin.id}/${target.view}`); return; }
    const action = n.action;
    if (!action) return;
    const session = sessions.find((s) => s.id === action.target);
    switch (action.kind) {
      case "url": void openExternal(action.target); break;
      case "settings": openSettings(action.target); break;
      case "agent": if (session) openSession(session, "agent"); break;
      case "canvas": {
        // Canvas node ids of agents are session ids; any other node id just opens the project canvas.
        if (session) { focusOnCanvas(session); break; }
        const project = n.projectId ?? activeProjectId ?? projects[0]?.id;
        if (project) openCanvas(project);
        break;
      }
    }
  }, [sessions, projects, activeProjectId, focusOnCanvas, openSession, openCanvas, openSettings, navigate]);
}
