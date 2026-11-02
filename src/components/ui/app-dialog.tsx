import type { ReactNode } from "react"
import { IconAlertTriangle, IconCheck, IconCopy } from "@tabler/icons-react"
import { cn } from "cn"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

const SIZES = {
  sm: "sm:max-w-[420px]",
  md: "sm:max-w-[520px]",
  lg: "sm:max-w-[640px]",
} as const

interface AppDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Brand or tabler icon, shown on a rounded tile. */
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  size?: keyof typeof SIZES
  children: ReactNode
  /** Right side of the footer band (Cancel / primary). */
  footer?: ReactNode
  /** Left side of the footer band (secondary links). */
  footerStart?: ReactNode
  /** false: no close button, Esc and outside clicks do nothing. */
  closable?: boolean
  className?: string
}

/** Shared dialog shell: icon tile + title header, padded body, footer band. */
function AppDialog({
  open,
  onOpenChange,
  icon,
  title,
  description,
  size = "md",
  children,
  footer,
  footerStart,
  closable = true,
  className,
}: AppDialogProps) {
  const block = (event: Event) => {
    if (!closable) event.preventDefault()
  }
  return (
    <Dialog open={open} onOpenChange={(next) => (closable || next) && onOpenChange(next)}>
      <DialogContent
        showCloseButton={closable}
        onEscapeKeyDown={block}
        onPointerDownOutside={block}
        onInteractOutside={block}
        className={cn("flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0", SIZES[size], className)}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border px-6 py-5 pr-12">
          {icon && (
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted ring-1 ring-foreground/5 [&_svg:not([class*='size-'])]:size-5">
              {icon}
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-0.5">
            <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
            {description && (
              <DialogDescription className="text-sm text-muted-foreground">
                {description}
              </DialogDescription>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {children}
        </div>
        {(footer || footerStart) && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-muted/40 px-6 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {footerStart}
            </div>
            <div className="flex items-center gap-2">{footer}</div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Inline error banner (instead of only a toast). */
function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <IconAlertTriangle />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

/** Numbered steps with a connector line. `current` is the 1-based active step. */
function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex flex-col">
      {steps.map((label, index) => {
        const n = index + 1
        const done = n < current
        const active = n === current
        return (
          <li key={label} className="relative flex gap-3 pb-3 last:pb-0">
            {index < steps.length - 1 && (
              <span
                aria-hidden
                className={cn("absolute top-6 left-[11px] h-[calc(100%-1.25rem)] w-px", done ? "bg-primary" : "bg-border")}
              />
            )}
            <span
              className={cn(
                "z-10 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                done && "border-primary bg-primary text-primary-foreground",
                active && "border-primary text-foreground",
                !done && !active && "border-border text-muted-foreground"
              )}
            >
              {done ? <IconCheck className="size-3.5" /> : n}
            </span>
            <span className={cn("pt-0.5 text-sm", active ? "font-medium" : "text-muted-foreground")}>{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

/** Large monospace code with per-character spacing and a copy button. */
function CodeBox({ code, copied, onCopy }: { code: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex items-center justify-center gap-3">
      <div className="flex gap-1.5" aria-label={code}>
        {[...code].map((char, index) =>
          char === "-" ? (
            <span key={index} className="self-center text-2xl text-muted-foreground">
              -
            </span>
          ) : (
            <span
              key={index}
              className="flex h-12 w-9 items-center justify-center rounded-lg border border-border bg-muted/50 font-mono text-2xl font-semibold"
            >
              {char}
            </span>
          )
        )}
      </div>
      <Button variant="outline" size="icon" aria-label="Copy code" onClick={onCopy}>
        {copied ? <IconCheck /> : <IconCopy />}
      </Button>
    </div>
  )
}

/** Status pill with a dot. */
function StatusPill({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        ok ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"
      )}
    >
      <span className={cn("size-1.5 rounded-full", ok ? "bg-emerald-500" : "bg-muted-foreground/50")} />
      {children}
    </span>
  )
}

export { AppDialog, ErrorBanner, Steps, CodeBox, StatusPill }
