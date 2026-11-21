import { cn } from "cn"
import { IconLoader } from "@tabler/icons-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <IconLoader data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin motion-reduce:animate-none", className)} {...props} />
  )
}

/** Centered spinner with a muted label, for loads whose item count is unknown (lists, grids, boards). */
function LoadingState({ label, className, ...props }: { label: string } & React.ComponentProps<"div">) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className={cn("flex items-center justify-center gap-2 text-sm text-muted-foreground", className)} {...props}>
      <Spinner role="presentation" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

export { Spinner, LoadingState }
