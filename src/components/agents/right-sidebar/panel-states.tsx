import type { ReactNode } from "react";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/spinner";
import { cn } from "cn";

export function PanelEmpty({ icon, title, hint, className }: { icon: ReactNode; title: string; hint?: string; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-10 text-center", className)}>
      <span className="flex size-10 items-center justify-center rounded-xl border border-border/70 bg-muted/70 text-muted-foreground [&_svg]:size-4.5">{icon}</span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="max-w-60 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function PanelError({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-2 px-6 py-8 text-center", className)}>
      <span className="flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive"><IconAlertTriangle className="size-4.5" /></span>
      <p className="max-w-64 text-xs text-muted-foreground">{message}</p>
      {onRetry && <Button type="button" variant="outline" size="xs" onClick={onRetry}><IconRefresh />Retry</Button>}
    </div>
  );
}

/** Centered spinner for panel loads; the number of rows is unknown, so no placeholder rows. */
export function RowSkeletons({ count = 6, rowClass = "h-6" }: { count?: number; rowClass?: string }) {
  void count; void rowClass;
  return <LoadingState label="Loading…" className="min-h-24 px-3 py-6" />;
}
