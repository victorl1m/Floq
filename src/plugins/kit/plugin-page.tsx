import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * The view shell for every plugin view: a scrolling area with the same title row and padding as Skills and Secrets.
 * One per plugin view. Colors, material and blur all come from the host theme; do not add your own.
 */
export function PluginPage({ title, description, actions, children, className }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className="absolute inset-0 overflow-y-auto" data-slot="plugin-page">
      <div className={cn("mx-auto flex min-h-full w-full max-w-5xl flex-col gap-5 p-5 md:gap-6 md:p-8", className)}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="page-heading mt-1 font-semibold tracking-tight">{title}</h1>
            {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}
