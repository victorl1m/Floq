import { useEffect, useState } from "react";
import { IconBox, type Icon } from "@tabler/icons-react";
import type { RuntimeProject } from "@/lib/runtime/types";
import { cn } from "cn";

type MarkProject = Pick<RuntimeProject, "imageUrl" | "gitUrl"> & Partial<Pick<RuntimeProject, "iconName" | "iconColor">>;

type CatalogModule = typeof import("@/components/projects/project-icon-catalog");
let catalog: CatalogModule | null = null;
let catalogLoad: Promise<void> | null = null;

/** The ~230-icon catalog stays out of the startup chunk: it loads the first time a project actually has an icon. */
function useCatalog(needed: boolean): CatalogModule | null {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!needed || catalog) return;
    let live = true;
    catalogLoad ??= import("@/components/projects/project-icon-catalog").then((module) => { catalog = module; });
    void catalogLoad.then(() => { if (live) rerender((n) => n + 1); }, () => { catalogLoad = null; });
    return () => { live = false; };
  }, [needed]);
  return catalog;
}

/** Precedence: catalog icon (iconName) > uploaded/linked image (imageUrl) > default box. An unknown or still-loading icon name falls through to the image. */
export function ProjectMark({ project, className }: { project: MarkProject; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const loaded = useCatalog(!!project.iconName);
  const Glyph: Icon | undefined = project.iconName ? loaded?.projectIconByName(project.iconName)?.Icon : undefined;
  if (Glyph) return <Glyph aria-hidden style={project.iconColor ? { color: project.iconColor } : undefined} className={cn("size-4 shrink-0", className)} />;
  const url = project.imageUrl && failedUrl !== project.imageUrl ? project.imageUrl : null;
  return url
    ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(project.imageUrl)} className={cn("size-4 shrink-0 rounded-sm object-cover", className)} />
    : <IconBox className={cn("size-4 shrink-0", className)} />;
}
