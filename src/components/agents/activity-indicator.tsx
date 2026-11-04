import type { SessionSummary } from "@/lib/runtime/types";
import { cn } from "cn";

/** "working" = the running agent has an open turn; "waiting" = stopped on a prompt. Idle/asleep/exited show nothing. */
export function agentActivity(session: Pick<SessionSummary, "state" | "activity">): "working" | "waiting" | null {
  if (session.state !== "running") return null;
  if (session.activity === "working") return "working";
  if (session.activity === "waiting-for-input") return "waiting";
  return null;
}

/** Three bouncing dots (CSS only, static under reduced motion) or a static amber dot when waiting for input. */
export function ActivityIndicator({ session, className }: { session: Pick<SessionSummary, "state" | "activity">; className?: string }) {
  const activity = agentActivity(session);
  if (!activity) return null;
  if (activity === "waiting") return <span role="status" title="Waiting for input" aria-label="Waiting for input" className={cn("size-1.5 shrink-0 rounded-full bg-amber-400", className)} />;
  return (
    <span role="status" title="Working" aria-label="Working" className={cn("inline-flex shrink-0 items-center gap-[2px]", className)}>
      {[0, 1, 2].map((index) => <span key={index} className="size-1 rounded-full bg-sky-500 animate-bounce motion-reduce:animate-none" style={{ animationDelay: `${index * 150}ms`, animationDuration: "900ms" }} />)}
    </span>
  );
}
