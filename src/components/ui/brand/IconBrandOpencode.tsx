import * as React from "react"
import { cn } from "cn"

export interface IconBrandOpencodeProps
  extends Partial<Omit<React.ComponentPropsWithoutRef<"svg">, "stroke">> {
  size?: string | number
  title?: string
}

// Original monochrome mark: a bracketed square (open code block) with a centred cursor bar.
const PATH = "M3 3h18v18H3V3Zm3 3v12h12V6H6Zm3 3h6v6H9V9Z"

const IconBrandOpencode = React.forwardRef<SVGSVGElement, IconBrandOpencodeProps>(
  ({ size = 24, title, className, color = "currentColor", ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role="img"
      aria-label={title ?? "OpenCode"}
      fill={color}
      className={cn("shrink-0", className)}
      {...props}
    >
      {title && <title>{title}</title>}
      <path fillRule="evenodd" d={PATH} />
    </svg>
  )
)
IconBrandOpencode.displayName = "IconBrandOpencode"

export default IconBrandOpencode
