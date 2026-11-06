// Loading the UI half of an installed plugin. Dependency-free (no React import) so scripts/test-plugin-remote-ui.mjs can run it under plain node.
import type { UiPluginDefinition } from "./sdk";

/** What the app shares with every remote UI bundle, so there is exactly one React and one kit. Tabler icons are not shared: bundles use `kit.resolvePluginIcon`. */
export interface SharedRuntime { react: unknown; jsx: unknown; kit: unknown; sdk: unknown }
declare global { var __FLOQ_PLUGIN_RT__: SharedRuntime | undefined }

export function installSharedRuntime(rt: SharedRuntime): void { globalThis.__FLOQ_PLUGIN_RT__ = rt; }

export async function sha256Text(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class RemoteUiError extends Error {}

export interface LoadOptions {
  /** Defaults to a Blob URL import. Tests pass a data: URL importer. */
  importer?: (source: string) => Promise<{ default?: unknown }>;
  sha256?: (text: string) => Promise<string>;
}

const blobImport = async (source: string) => {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try { return (await import(/* @vite-ignore */ url)) as { default?: unknown }; } finally { URL.revokeObjectURL(url); }
};

/**
 * Checks the bundle against the sha256 the runtime lists for the plugin (and the one it sent with the file), then imports it.
 * The shared runtime must be installed first: the bundle reads React, the kit and the SDK from it.
 */
export async function loadRemoteUi(text: string, expectedSha256: string, headerSha256: string, options: LoadOptions = {}): Promise<UiPluginDefinition> {
  const digest = await (options.sha256 ?? sha256Text)(text);
  if (!expectedSha256 || digest !== expectedSha256 || (headerSha256 && headerSha256 !== digest)) throw new RemoteUiError("The plugin UI does not match its checksum.");
  if (!globalThis.__FLOQ_PLUGIN_RT__) throw new RemoteUiError("The plugin runtime is not ready.");
  const mod = await (options.importer ?? blobImport)(text);
  const def = mod.default;
  if (!def || typeof def !== "object") throw new RemoteUiError("The plugin UI has no default export.");
  return def as UiPluginDefinition;
}
