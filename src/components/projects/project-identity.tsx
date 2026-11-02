import { useState } from "react";
import { IconFolder, IconGitBranch } from "@tabler/icons-react";
import type { RuntimeProject } from "@/lib/runtime/types";
import { cn } from "cn";

export function ProjectMark({ project, className }: { project: Pick<RuntimeProject, "imageUrl" | "gitUrl">; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = project.imageUrl && failedUrl !== project.imageUrl ? project.imageUrl : null;
  return url
    ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(project.imageUrl)} className={cn("size-4 shrink-0 rounded-sm object-cover", className)} />
    : project.gitUrl ? <IconGitBranch className={cn("size-4 shrink-0", className)} /> : <IconFolder className={cn("size-4 shrink-0", className)} />;
}
