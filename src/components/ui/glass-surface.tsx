import { Glass } from "glisse";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Shared optical material. Keep application semantics on the owning control. */
export function GlassSurface({ className, ...props }: ComponentProps<typeof Glass>) {
  return <Glass className={cn("floq-glass glass-panel", className)} {...props} />;
}
