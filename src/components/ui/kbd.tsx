import { cn } from "cn"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 w-fit items-center justify-center gap-1 rounded-[5px] border border-border bg-muted/80 px-1.5 font-sans text-[11px] leading-none font-medium text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.9),0_1px_0_rgb(0_0_0/0.12)] select-none dark:bg-muted dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_1px_0_rgb(0_0_0/0.55)] in-data-[slot=tooltip-content]:border-transparent in-data-[slot=tooltip-content]:bg-foreground/10 in-data-[slot=tooltip-content]:text-popover-foreground in-data-[slot=tooltip-content]:shadow-none dark:in-data-[slot=tooltip-content]:bg-foreground/15 in-data-[floq-variant=default]:border-primary-foreground/25 in-data-[floq-variant=default]:bg-primary-foreground/15 in-data-[floq-variant=default]:text-primary-foreground in-data-[floq-variant=default]:shadow-none dark:in-data-[floq-variant=default]:bg-primary-foreground/15 dark:in-data-[floq-variant=default]:shadow-none [&_svg:not([class*='size-'])]:size-3",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
