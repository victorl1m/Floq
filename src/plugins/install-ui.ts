// Pure rules for the plugin catalog dialog. Relative imports only (runs under plain node tests).
import type { PluginCatalogItem, PluginRepoPreview, PluginUpdateNotice } from "../lib/runtime/types";

/** Shown in the install dialog and in docs/plugins/README.md. It states what is and is not enforced. */
export const TRUST_WARNING =
  "Installed plugins run inside the Floq runtime with its full privileges and inside the app with your session. Floq checks that the package is the exact one published in floq-plugins (sha256), and gives plugins a limited API (declared secrets only, allow-listed hosts, their own database schema). That API is a guard rail, not a sandbox: malicious plugin code could read any user's data, the encryption key and secrets, or your session token. Install only plugins you trust as much as Floq itself.";

export type CatalogAction = "install" | "update" | "uninstall" | "purge";

export interface RowState { status: "builtin" | "available" | "installed" | "update"; actions: CatalogAction[] }

/** What an admin can do with a catalog entry. Built-ins can do nothing; "delete data" is for plugins that are not installed any more or are off (the server refuses it while running). */
export function rowState(item: Pick<PluginCatalogItem, "builtin" | "installedVersion" | "updateAvailable">): RowState {
  if (item.builtin) return { status: "builtin", actions: [] };
  if (item.installedVersion === null) return { status: "available", actions: ["install", "purge"] };
  return item.updateAvailable ? { status: "update", actions: ["update", "uninstall"] } : { status: "installed", actions: ["uninstall"] };
}

/** The typed confirmation: exact id, nothing else. */
export const confirmMatches = (typed: string, id: string) => typed.trim() === id;

const WORDS: Record<string, string> = { taskSources: "task sources", views: "a screen", rightSidebarTabs: "side panel tabs", routes: "its own routes", internalRoutes: "agent access", webhooks: "webhooks", mcpServers: "MCP servers", skills: "skills" };

/** One line for the row: what the plugin needs and reaches, so the admin sees it before installing. */
export function summarize(item: Pick<PluginCatalogItem, "secrets" | "network" | "contributes" | "scope">): string[] {
  const out: string[] = [item.scope === "install" ? "One setup for the whole runtime" : "Each user turns it on"];
  if (item.secrets.length) out.push("Secrets: " + item.secrets.join(", "));
  if (item.network.length) out.push("Contacts: " + item.network.join(", "));
  const adds = item.contributes.map((c) => WORDS[c] ?? c);
  if (adds.length) out.push("Adds: " + adds.join(", "));
  return out;
}

export const ACTION_LABEL: Record<CatalogAction, string> = { install: "Install", update: "Update", uninstall: "Uninstall", purge: "Delete data" };

/** Shown when the package comes from a repository the admin typed in, not from the floq-plugins catalog. Nobody but that repository's owner vouches for it. */
export const REPO_TRUST_WARNING =
  "This plugin comes from a GitHub repository you chose, not from the floq-plugins catalog. Floq cannot vouch for its author. Once installed it runs inside the Floq runtime with its full privileges and inside the app with your session, and Floq's plugin API is a guard rail, not a sandbox: malicious code could read any user's data, the encryption key and secrets, or your session token. Install it only if you trust the repository's owner as much as Floq itself, and only after reading the code.";

/** `owner/repo` as a link-free label, and the facts the admin reviews (what it asks for and reaches) before confirming. */
export function previewLines(p: Pick<PluginRepoPreview, "repo" | "tag" | "version" | "secrets" | "network" | "contributes" | "scope" | "sha256" | "size">): string[] {
  const out = [`Repository: ${p.repo}${p.tag ? ` (${p.tag})` : ""}`, `Version: ${p.version}`, ...summarize(p)];
  out.push(`sha256: ${p.sha256}`);
  return out;
}

/** Text of the toast shown when the app opens: names up to three plugins, then a count. Null when nothing needs attention. */
export function updateToast(updates: Pick<PluginUpdateNotice, "name" | "installedVersion" | "availableVersion">[]): { title: string; description: string } | null {
  if (!updates.length) return null;
  const list = updates.slice(0, 3).map((u) => `${u.name} ${u.installedVersion} to ${u.availableVersion}`).join(", ");
  const more = updates.length > 3 ? ` and ${updates.length - 3} more` : "";
  return { title: updates.length === 1 ? "A plugin update is available" : `${updates.length} plugin updates are available`, description: `${list}${more}. Update them in Settings > Plugins.` };
}
