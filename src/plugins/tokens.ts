/**
 * Semantic tokens plugin UI may rely on (Tailwind utilities such as `bg-card` or `text-muted-foreground` map to these).
 * `src/index.css` stays the only token source. scripts/test-plugin-tokens.mjs checks that every color token is defined for both the
 * light theme (the top-level `:root` blocks) and the dark theme (the `.dark` block), so renaming or dropping one in core fails loudly instead of breaking plugins.
 */
export const PLUGIN_COLOR_TOKENS = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
  "primary", "primary-hover", "primary-text", "primary-foreground", "secondary", "secondary-foreground",
  "muted", "muted-foreground", "accent", "accent-foreground", "destructive", "border", "input", "ring",
  "sidebar", "sidebar-foreground", "sidebar-border", "sidebar-accent", "sidebar-accent-foreground",
] as const;

/** Defined once (same in both themes). */
export const PLUGIN_SHARED_TOKENS = ["radius", "font-sans", "font-mono"] as const;

export type PluginColorToken = (typeof PLUGIN_COLOR_TOKENS)[number];
