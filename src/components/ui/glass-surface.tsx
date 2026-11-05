import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Stable opaque plane. */
export function GlassSurface({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("floq-surface rounded-2xl", className)} {...props} />;
}

