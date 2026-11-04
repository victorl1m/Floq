/**
 * "Terminal in home": a project-less shell that starts in the runtime user's own home directory
 * (the per-user encrypted volume, $HOME inside the sandbox) instead of a scratch `workspace/<id>` folder.
 *
 * The client only sends a boolean (`home: true`); it never supplies the path, so there is nothing to traverse.
 * The cwd stored for the session is the home root itself, the same relative form every other session cwd uses.
 */
export const HOME_CWD = ".";

export interface HomeShellRequest {
  provider: string;
  home?: unknown;
  cwd?: unknown;
  projectId?: unknown;
  workspaceId?: unknown;
  gitUrl?: unknown;
  isolated?: unknown;
}

/** True when the request asks for a home terminal. Throws a message (caller maps it to a 400) when it is malformed or combined with other placement. */
export function wantsHomeShell(input: HomeShellRequest): boolean {
  if (input.home === undefined || input.home === false) return false;
  if (input.home !== true) throw new Error("home must be a boolean");
  if (input.provider !== "shell") throw new Error("home is only supported for shell sessions");
  if (input.cwd || input.projectId || input.workspaceId || input.gitUrl || input.isolated) {
    throw new Error("home cannot be combined with cwd, project, workspace, gitUrl or isolated");
  }
  return true;
}
