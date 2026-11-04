import { AsciiSkeleton, AsciiReveal, type AsciiRevealProps } from "ascii-reveal"
import { usePerformancePrefs } from "@/lib/prefs"
import { cn } from "cn"

function Skeleton({ className, animate = false, rows = 3, ...props }: React.ComponentProps<"div"> & { animate?: boolean; rows?: number }) {
  const [{ reduceMotion }] = usePerformancePrefs()
  return (
    <div data-slot="skeleton" aria-hidden="true" className={cn("relative min-w-0 overflow-hidden rounded-md text-muted-foreground", className)} {...props}>
      <AsciiSkeleton
        variant="dither"
        rows={rows}
        width="100%"
        height="100%"
        animate={animate && !reduceMotion}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
    </div>
  )
}

type FloqRevealProps = Pick<AsciiRevealProps, "preset" | "speed" | "duration" | "loading" | "revealOnMount" | "revealOnHydrate" | "selector" | "lazy" | "fallback" | "onRevealComplete"> & React.HTMLAttributes<HTMLDivElement> & {
  children?: React.ReactNode
}

function FloqReveal({
  children,
  preset,
  speed,
  duration,
  loading,
  revealOnMount,
  revealOnHydrate,
  selector,
  lazy,
  fallback,
  onRevealComplete,
  ...htmlProps
}: FloqRevealProps) {
  const [{ reduceMotion }] = usePerformancePrefs()
  return <AsciiReveal
    {...htmlProps}
    preset={preset}
    speed={speed}
    duration={duration}
    loading={reduceMotion ? false : loading}
    revealOnMount={reduceMotion ? false : revealOnMount}
    revealOnHydrate={reduceMotion ? false : revealOnHydrate}
    selector={selector}
    lazy={lazy}
    fallback={fallback}
    onRevealComplete={onRevealComplete}
  >{children}</AsciiReveal>
}

export { Skeleton, FloqReveal }
