import type { ReactNode } from "react";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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

/** Fixed-height placeholder rows so content does not jump when it arrives. */
export function RowSkeletons({ count = 6, rowClass = "h-6" }: { count?: number; rowClass?: string }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-1.5 p-3">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className={cn(rowClass, "rounded-md")} style={{ width: `${95 - ((index * 17) % 40)}%` }} />
      ))}
    </div>
  );
}
