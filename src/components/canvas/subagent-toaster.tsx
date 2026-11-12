import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useRuntime } from "@/lib/runtime/store";
import { roleLabel } from "@/lib/role-icons";
import { AgentAvatar } from "@/components/agents/agent-avatar";

/**
 * Headless: announces an agent recruiting a subagent (a new session that has a recruiting parent) with the shared toast.
 * Sessions present on the first load, or already announced, are never toasted again. Toasts are informational only: the
 * canvas wire and the "Subagent" badge carry the same fact.
 */
export function SubagentToaster() {
  const { sessions, loaded } = useRuntime();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!loaded) return;
    if (seen.current === null) {
      seen.current = new Set(sessions.map((session) => session.id));
      return;
    }
    const known = seen.current;
    for (const session of sessions) {
      if (known.has(session.id)) continue;
      known.add(session.id);
      if (!session.parentSessionId) continue;
      const parent = sessions.find((item) => item.id === session.parentSessionId);
      toast.info(`${parent?.title ?? "An agent"} recruited ${session.title}`, {
        icon: <AgentAvatar session={session} size={20} />,
        description: session.role ? `Subagent, ${roleLabel(session.role)}. Wired to its parent on the canvas.` : "Subagent. Wired to its parent on the canvas.",
      });
    }
  }, [sessions, loaded]);

  return null;
}
