import { PLUGIN_MARKER } from "./host.js";

/** The slice of SkillsService the removal needs (so it can be tested with a fake). */
export interface OwnedSkillsApi {
  list(userId: string): Promise<{ skills: { name: string; source: string; provider: "claude" | "codex"; location: string; origin?: string }[] }>;
  readSkillFiles(userId: string, input: { scope: "global"; provider: "claude" | "codex"; source: "home"; location: string; path: string }): Promise<unknown>;
  deleteSkill(userId: string, input: { provider: "claude" | "codex"; location: string }): Promise<unknown>;
}

const base = (location: string) => location.split("/").filter(Boolean).at(-1) ?? "";

/**
 * Removes the copies of skill `name` that plugin `pluginId` installed in the user's home, and nothing else: a copy counts only when its
 * `.floq-plugin` marker names this plugin. A skill the user already had (no marker, or another plugin's), and any bundled skill of the
 * same name, are left alone. Returns how many copies were removed.
 */
export async function removeOwnedPluginSkill(skills: OwnedSkillsApi, userId: string, name: string, pluginId: string): Promise<number> {
  const { skills: all } = await skills.list(userId);
  const same = all.filter((s) => (s.name === name || base(s.location) === name) && !s.origin);
  // Deleting a skill that also ships in the image bundle would record a removal for the bundled one: never do that here.
  if (same.some((s) => s.source === "bundled")) return 0;
  let removed = 0;
  for (const copy of same.filter((s) => s.source === "home")) {
    let marker: string | undefined;
    try {
      const file = (await skills.readSkillFiles(userId, { scope: "global", provider: copy.provider, source: "home", location: copy.location, path: PLUGIN_MARKER })) as { content?: string };
      marker = file?.content;
    } catch { continue; /* no marker: not ours */ }
    let owner: unknown;
    try { owner = (JSON.parse(marker ?? "") as { pluginId?: unknown }).pluginId; } catch { continue; }
    if (owner !== pluginId) continue;
    await skills.deleteSkill(userId, { provider: copy.provider, location: copy.location });
    removed++;
  }
  return removed;
}
