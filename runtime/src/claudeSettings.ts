import { constants, fstatSync, lstatSync, openSync, readSync, closeSync } from "node:fs";

/** Keep startup consent aligned with the user's explicit Floq auto-approve choice. */
export function claudeStartupSettings(settings: Record<string, unknown>, autoApprove: boolean): Record<string, unknown> {
  return { ...settings, tui: "fullscreen", skipDangerousModePermissionPrompt: autoApprove };
}

const MAX_CLAUDE_CONFIG_BYTES = 8 * 1024 * 1024;

/** Read Claude's mutable home config without following a user-created symlink. */
export function readClaudeProjectConfig(path: string): Record<string, unknown> {
  let fd: number;
  try {
    // O_NOFOLLOW closes the lstat/open race on platforms that support it. lstat
    // also gives a clear rejection on platforms where the flag is unavailable.
    if (lstatSync(path).isSymbolicLink()) throw new Error("Claude configuration must not be a symlink");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }

  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("Claude configuration must be a regular file");
    if (info.size > MAX_CLAUDE_CONFIG_BYTES) throw new Error("Claude configuration is too large");
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_CLAUDE_CONFIG_BYTES) throw new Error("Claude configuration is too large");
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Claude configuration");
    return value as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

/** Trust only the exact managed checkouts selected for this launch. */
export function claudeProjectTrust(config: Record<string, unknown>, directories: string[]): Record<string, unknown> {
  const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const projects = isRecord(config.projects) ? { ...config.projects } : {};
  for (const directory of directories) {
    projects[directory] = {
      ...(isRecord(projects[directory]) ? projects[directory] : {}),
      hasTrustDialogAccepted: true,
    };
  }
  return { ...config, projects };
}
