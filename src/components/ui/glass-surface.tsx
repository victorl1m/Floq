import * as React from "react";
import type { ComponentProps } from "react";
import { Glass } from "glisse";
import { cn } from "@/lib/utils";
import { useForcedColorsPreference, useMaterialPreference } from "@/lib/material-preference";

/** Stable opaque plane. Glisse refraction is added only to bounded surfaces after profiling. */
export function GlassSurface({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("floq-surface rounded-2xl", className)} {...props} />;
}

/** Opt-in Glisse material for a small, bounded surface. */
export function GlisseSurface({ className, ...props }: ComponentProps<typeof Glass>) {
  const [material] = useMaterialPreference();
  const forcedColors = useForcedColorsPreference();
  const prefersReducedTransparency = React.useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const query = window.matchMedia("(prefers-reduced-transparency: reduce)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches,
    () => false,
  );

  const renderGlass = !forcedColors && material === "glass" && !prefersReducedTransparency;
  const classes = cn(renderGlass ? "floq-glass" : "floq-surface", "rounded-xl", className);
  if (!renderGlass) {
    return <div className={classes} {...props} />;
  }
  return <Glass className={classes} {...props} />;
}
