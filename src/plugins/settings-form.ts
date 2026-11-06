// Pure draft handling for the generic plugin settings form. Relative imports only (runs under plain node tests).
import type { PluginSettingDecl, PluginSettingValues } from "../lib/runtime/types";

/** Text the user is editing, one string per field (booleans are "true" / "false"). */
export type Draft = Record<string, string>;

export function initialDraft(decls: PluginSettingDecl[], values: PluginSettingValues): Draft {
  const draft: Draft = {};
  for (const d of decls) {
    const v = values[d.key];
    draft[d.key] = d.type === "boolean" ? String(v === true) : v === undefined || v === null ? "" : String(v);
  }
  return draft;
}

export interface DraftResult { values: PluginSettingValues; errors: Record<string, string> }

/** Draft -> payload for `PUT /v1/plugins/:id/settings`. Empty optional fields are omitted. Messages name the field, never echo the value. */
export function draftToValues(decls: PluginSettingDecl[], draft: Draft): DraftResult {
  const values: PluginSettingValues = {};
  const errors: Record<string, string> = {};
  for (const d of decls) {
    const raw = (draft[d.key] ?? "").trim();
    if (d.type === "boolean") { values[d.key] = raw === "true"; continue; }
    if (!raw) { if (d.required) errors[d.key] = `${d.label} is required.`; continue; }
    if (d.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) errors[d.key] = `${d.label} must be a number.`; else values[d.key] = n;
    } else if (d.type === "url") {
      try { const u = new URL(raw); if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(); values[d.key] = raw; }
      catch { errors[d.key] = `${d.label} must be a valid http(s) URL.`; }
    } else if (d.type === "select") {
      if (d.options?.some((o) => o.value === raw)) values[d.key] = raw; else errors[d.key] = `Choose one of the options for ${d.label}.`;
    } else if (d.type === "secretRef") {
      if (/^[A-Z][A-Z0-9_]{0,63}$/.test(raw)) values[d.key] = raw; else errors[d.key] = `${d.label} must be a secret name like MY_SECRET.`;
    } else values[d.key] = raw;
  }
  return { values, errors };
}

export const isDirty = (decls: PluginSettingDecl[], draft: Draft, saved: PluginSettingValues): boolean => {
  const base = initialDraft(decls, saved);
  return decls.some((d) => (draft[d.key] ?? "").trim() !== base[d.key].trim());
};
