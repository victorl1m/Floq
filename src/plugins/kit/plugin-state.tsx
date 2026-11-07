import type { ReactNode } from "react";
import { IconAlertTriangle, IconInbox, IconKey, IconPlugOff, IconSettings } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { usePlugins } from "@/plugins/host";

export type PluginStateKind = "loading" | "empty" | "error" | "not-configured" | "disabled";

export interface PluginStateProps {
  state: PluginStateKind;
  /** Overrides the default heading. */
  title?: string;
  description?: ReactNode;
  /** error: shows a Retry action. Entered values stay with the caller; this component never clears anything. */
  onRetry?: () => void;
  /** not-configured: names of declared secrets / settings that are still missing. */
  missingSecrets?: string[];
  missingSettings?: string[];
  /** Label used in loading status text, for example "tickets". */
  label?: string;
  children?: ReactNode;
}

const COPY: Record<Exclude<PluginStateKind, "loading">, { title: string; description: string }> = {
  empty: { title: "Nothing here yet", description: "There is nothing to show right now." },
  error: { title: "Could not load this", description: "Something went wrong. Try again." },
  "not-configured": { title: "Finish setting this up", description: "This plugin needs the items below before it can load." },
  disabled: { title: "This plugin is turned off", description: "Turn it on in Settings > Plugins to use it." },
};

/** One component for loading, empty, error, not-configured and disabled, so every plugin reads the same. */
export function PluginState({ state, title, description, onRetry, missingSecrets = [], missingSettings = [], label = "content", children }: PluginStateProps) {
  const { openSettings } = usePlugins();
  if (state === "loading") {
    return (
      <div role="status" aria-label={`Loading ${label}`} data-slot="plugin-state" data-state="loading" className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/30">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-3 w-40" /><Skeleton className="h-2.5 w-3/4" /></div>
            <Skeleton className="h-5 w-14" />
          </div>
        ))}
        <span className="sr-only">Loading {label}…</span>
      </div>
    );
  }
  const copy = COPY[state];
  const Icon = state === "error" ? IconAlertTriangle : state === "not-configured" ? IconKey : state === "disabled" ? IconPlugOff : IconInbox;
  return (
    <Empty data-state={state} data-slot="plugin-state" className="min-h-52 flex-none bg-card/20 px-5 py-8" role={state === "error" ? "alert" : undefined}>
      <EmptyHeader>
        <EmptyMedia variant="icon"><Icon /></EmptyMedia>
        <EmptyTitle>{title ?? copy.title}</EmptyTitle>
        <EmptyDescription>{description ?? copy.description}</EmptyDescription>
      </EmptyHeader>
      {state === "not-configured" && (missingSecrets.length > 0 || missingSettings.length > 0) && (
        <ul className="max-w-sm space-y-1 text-left text-xs text-muted-foreground">
          {missingSecrets.map((n) => <li key={"s" + n}>Credential <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{n}</code></li>)}
          {missingSettings.map((n) => <li key={"t" + n}>Setting <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{n}</code></li>)}
        </ul>
      )}
      <EmptyContent className="flex-row flex-wrap justify-center gap-2">
        {state === "error" && onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>}
        {state === "not-configured" && missingSecrets.length > 0 && <Button size="sm" onClick={openSettings}><IconKey /> Open plugin settings</Button>}
        {state === "disabled" && <Button variant="outline" size="sm" onClick={openSettings}><IconSettings /> Plugin settings</Button>}
        {state === "not-configured" && missingSecrets.length === 0 && <Button variant="outline" size="sm" onClick={openSettings}><IconSettings /> Plugin settings</Button>}
        {children}
      </EmptyContent>
    </Empty>
  );
}
