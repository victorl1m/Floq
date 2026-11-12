/** Where an item lives inside a project's WebDAV share: `[<share folder name>, ...path segments]`. */
export interface MountItem { label: string; rel: string }

/**
 * Segments of an item inside the share, or [] (the share root) when the folder cannot be matched.
 * `folders` are the share's top-level collection names in the runtime's order; `label` is the files-tab target label.
 * One folder: it is the folder. Several: match by name (exact, then case-insensitive), else fall back to the root.
 */
export function mountSegments(folders: readonly string[], item: MountItem | undefined): string[] {
  if (!item) return [];
  const rest = item.rel.split("/").filter((part) => part !== "" && part !== ".");
  if (rest.some((part) => part === "..")) return [];
  const folder = folders.length === 1
    ? folders[0]
    : folders.find((name) => name === item.label) ?? folders.find((name) => name.toLowerCase() === item.label.toLowerCase());
  return folder === undefined ? [] : [folder, ...rest];
}
