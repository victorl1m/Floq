import * as React from "react"
import { cn } from "cn"

export interface IconBrandAntigravityProps
  extends Partial<Omit<React.ComponentPropsWithoutRef<"svg">, "stroke">> {
  size?: string | number
  title?: string
}

// Original monochrome mark: an upward arch with a floating dot above it.
const ARCH = "M3 20 12 8l9 12h-4.2L12 13.6 7.2 20H3Z"

const IconBrandAntigravity = React.forwardRef<SVGSVGElement, IconBrandAntigravityProps>(
  ({ size = 24, title, className, color = "currentColor", ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role="img"
      aria-label={title ?? "Antigravity"}
      fill={color}
      className={cn("shrink-0", className)}
      {...props}
    >
      {title && <title>{title}</title>}
      <path d={ARCH} />
      <circle cx="12" cy="4.5" r="2" />
    </svg>
  )
)
IconBrandAntigravity.displayName = "IconBrandAntigravity"

export default IconBrandAntigravity
