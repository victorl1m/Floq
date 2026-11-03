import { IconBox, IconChevronDown, IconGitBranch, IconPlus } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { ProjectMark } from "@/components/projects/project-identity";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ProjectChoice {
  id: string;
  name: string;
  displayName?: string | null;
  imageUrl: string | null;
  gitUrl: string | null;
  workspaces?: Array<{ id: string; name: string; branch?: string | null; isWorktree?: boolean }>;
}

interface ProjectPickerProps {
  projects: ProjectChoice[];
  selectedProjectId: string | null;
  selectedWorkspaceId?: string | null;
  onSelect: (project: ProjectChoice, workspaceId?: string) => void;
  onAddProject: () => void;
  disabled?: boolean;
  className?: string;
}

export default function ProjectPicker({
  projects,
  selectedProjectId,
  selectedWorkspaceId,
  onSelect,
  onAddProject,
  disabled,
  className,
}: ProjectPickerProps) {
  const selected = projects.find((project) => project.id === selectedProjectId);
  const selectedWorkspace = selected?.workspaces?.find((workspace) => workspace.id === selectedWorkspaceId);
  const projectName = selected?.displayName?.trim() || selected?.name;
  const workspaceLabel = selectedWorkspace?.branch || selectedWorkspace?.name;
  const label = selected
    ? selectedWorkspace && (selectedWorkspace.isWorktree || (selectedWorkspace.branch && selectedWorkspace.branch !== "main"))
      ? `${projectName} · ${workspaceLabel}`
      : projectName
    : "Select project";
  const hasChoices = projects.some((project) => (project.workspaces?.length ?? 0) > 1);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={className ?? "text-muted-foreground"} disabled={disabled}>
          {selectedWorkspace?.isWorktree ? <IconGitBranch /> : selected ? <ProjectMark project={selected} /> : <IconBox />}
          <span className="max-w-52 truncate">{label}</span>
          <IconChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-max max-w-[360px] min-w-[max(260px,var(--radix-dropdown-menu-trigger-width))]">
        {projects.length === 0 ? (
          <DropdownMenuLabel className="max-w-64 whitespace-normal font-normal text-muted-foreground">
            Add a project before starting an agent.
          </DropdownMenuLabel>
        ) : hasChoices ? (
          <DropdownMenuLabel>Projects and workspaces</DropdownMenuLabel>
        ) : null}
        {projects.flatMap((project) => {
          const name = project.displayName?.trim() || project.name;
          const workspaces = project.workspaces ?? [];
          if (!workspaces.length) {
            return [
              <DropdownMenuItem key={project.id} onSelect={() => onSelect(project)}>
              <ProjectMark project={project} />
                <span className="truncate" title={name}>{name}</span>
              </DropdownMenuItem>,
            ];
          }
          return workspaces.map((workspace) => (
            <DropdownMenuItem key={`${project.id}:${workspace.id}`} onSelect={() => onSelect(project, workspace.id)}>
              {workspace.isWorktree ? <IconGitBranch /> : <ProjectMark project={project} />}
              <span className="min-w-0 truncate" title={`${name} · ${workspace.branch || workspace.name}`}>
                {name}{workspaces.length > 1 ? ` · ${workspace.branch || workspace.name}` : ""}
              </span>
            </DropdownMenuItem>
          ));
        })}
        {projects.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={onAddProject}>
          <IconPlus />
          Add project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
