/**
 * Single source of truth for per-provider visual identity (palette tokens only, no logos).
 * The same values are mirrored as CSS variables in the marked block of src/index.css; contrast of every
 * accent was checked (>= 4.5:1 text, >= 3:1 icons/borders) on the light, dark and solid surfaces.
 * See docs/redesign/provider-themes.md for how to add a provider.
 */
export type ProviderThemeMode = "light" | "dark";
export interface ProviderPalette {
    /** Icons, selection border, key text on the surface. */
    accent: string;
    /** Text drawn on a filled accent. */
    accentForeground: string;
}
export interface ProviderTheme {
    id: string;
    label: string;
    light: ProviderPalette;
    dark: ProviderPalette;
}

export const PROVIDER_THEMES: Record<string, ProviderTheme> = {
    claude: { id: "claude", label: "Claude Code", light: { accent: "#B4502C", accentForeground: "#FFFFFF" }, dark: { accent: "#E08A6A", accentForeground: "#1A0E08" } },
    codex: { id: "codex", label: "Codex", light: { accent: "#0A7C61", accentForeground: "#FFFFFF" }, dark: { accent: "#2FBF9A", accentForeground: "#04130F" } },
    opencode: { id: "opencode", label: "OpenCode", light: { accent: "#1F5FBF", accentForeground: "#FFFFFF" }, dark: { accent: "#6FA8F5", accentForeground: "#07111F" } },
    antigravity: { id: "antigravity", label: "Antigravity", light: { accent: "#7A3FC4", accentForeground: "#FFFFFF" }, dark: { accent: "#B58AF0", accentForeground: "#150A24" } },
    shell: { id: "shell", label: "Terminal", light: { accent: "#5F6673", accentForeground: "#FFFFFF" }, dark: { accent: "#A1A1A6", accentForeground: "#000000" } },
};

/** Unknown providers fall back to the app accent (CSS keeps --primary-text as the default). */
export function getProviderTheme(provider: string): ProviderTheme | undefined {
    return PROVIDER_THEMES[provider];
}

/** Spread onto an element: `<div {...providerThemeProps(session.provider)}>`; CSS then exposes --provider-*. */
export function providerThemeProps(provider: string): { "data-provider": string } {
    return { "data-provider": provider };
}

/** For canvas/xterm code that needs a concrete colour instead of a CSS variable. */
export function providerAccent(provider: string, mode: ProviderThemeMode): string | undefined {
    return PROVIDER_THEMES[provider]?.[mode].accent;
}

/** Tailwind-friendly class fragments backed by the CSS variables (fall back to app accent). */
export const providerClass = {
    text: "text-(--provider-accent)",
    selectedBorder: "border-(--provider-accent)",
    rim: "border-(--provider-rim)",
    tint: "bg-(--provider-tint)",
    selection: "bg-(--provider-selection)",
} as const;
