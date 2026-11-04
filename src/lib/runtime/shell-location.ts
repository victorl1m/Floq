/**
 * Where a terminal session lives, for tab labels. A shell with no project runs relative to the runtime
 * user's own home directory (the sandbox $HOME), so its cwd is shown as `~` or `~/sub/dir`.
 */
export function homeRelativeCwd(cwd: string | null | undefined): string {
  const parts = (cwd ?? "").split("/").filter((part) => part && part !== ".");
  return parts.length ? `~/${parts.join("/")}` : "~";
}

/** Short location label: project name for project terminals, `~`-relative path otherwise. */
export function shellLocationLabel(session: { projectId?: string | null; cwd?: string | null }, projectName?: string | null): string {
  if (session.projectId && projectName) return projectName;
  return homeRelativeCwd(session.cwd);
}

export function isHomeShell(session: { projectId?: string | null; cwd?: string | null }): boolean {
  return !session.projectId && homeRelativeCwd(session.cwd) === "~";
}
