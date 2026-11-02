import * as React from "react"
import { cn } from "cn"

export interface IconBrandFlowlessProps
  extends Partial<Omit<React.ComponentPropsWithoutRef<"svg">, "stroke">> {
  size?: string | number
  stroke?: string | number
  title?: string
}

const IconBrandFlowless = React.forwardRef<
  SVGSVGElement,
  IconBrandFlowlessProps
>(
  (
    {
      size = 24,
      stroke = 58,
      color = "#fe5d00",
      title,
      className,
      children,
      ...props
    },
    ref
  ) => {
    const uid = React.useId().replace(/:/g, "")

    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 512 512"
        width={size}
        height={size}
        color={color}
        className={cn("tabler-icon tabler-icon-brand-flowless", className)}
        {...props}
      >
        {title ? <title>{title}</title> : null}
        <rect width="512" height="512" rx="0" fill={`url(#full-${uid})`} />
        <g transform="translate(256,256) scale(0.86) translate(-256,-256)">
          <path
            d="M 118,256 q 69,-92 138,0 t 138,0"
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        </g>
        {children}
      </svg>
    )
  }
)

IconBrandFlowless.displayName = "IconBrandFlowless"

export default IconBrandFlowless
