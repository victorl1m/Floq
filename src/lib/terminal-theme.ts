import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import type { ITheme } from "@xterm/xterm";

/**
 * xterm palettes. The terminal follows the resolved app theme (light / dark / system via next-themes);
 * the dark palette is the original OLED one, unchanged. Hexes for `background` are mirrored by
 * `--terminal-bg` in src/index.css so the frame around the canvas matches the canvas exactly.
 */
export const DARK_TERMINAL_THEME = {
    background: "#0c0c0e",
    foreground: "#e4e4e7",
    cursor: "#e4e4e7",
    cursorAccent: "#0c0c0e",
    selectionBackground: "#3f3f46",
    black: "#18181b",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#facc15",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#e4e4e7",
    brightBlack: "#52525b",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde047",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#fafafa",
} satisfies ITheme;

/**
 * Light palette: a GitHub-Light-like scheme re-tuned so every text-carrying colour (all 16 except
 * brightBlack/white pairs used as backgrounds) reaches >= 4.5:1 on the surface. Surface is a hair below
 * the app's light card (#fbfcfe) so the terminal reads as a recessed well, not a stark white sheet.
 */
export const LIGHT_TERMINAL_THEME = {
    background: "#f6f8fa",
    foreground: "#1f2328",
    cursor: "#1f2328",
    cursorAccent: "#f6f8fa",
    selectionBackground: "#b6d6fb",
    selectionInactiveBackground: "#d0d7de",
    black: "#24292f",
    red: "#c4161f",
    green: "#116329",
    yellow: "#7a4b00",
    blue: "#0550ae",
    magenta: "#7d3fd0",
    cyan: "#0e6c78",
    white: "#59636e",
    brightBlack: "#4f5964",
    brightRed: "#a40e26",
    brightGreen: "#0f5a24",
    brightYellow: "#6a4000",
    brightBlue: "#0a5fc0",
    brightMagenta: "#6a32b8",
    brightCyan: "#0a5c68",
    brightWhite: "#3d4650",
} satisfies ITheme;

/** Dark keeps the stock behaviour (1 = no adjustment); light enforces WCAG AA for stray low-contrast SGR output. */
export const minimumContrastRatio = (dark: boolean) => (dark ? 1 : 4.5);

const rgba = (hex: string, alpha: number) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

export function terminalTheme(dark: boolean, transparentBackground = false): ITheme {
    const base: ITheme = dark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
    return transparentBackground ? { ...base, background: rgba(base.background as string, dark ? 0.86 : 0.9) } : base;
}

export const terminalBackground = (dark: boolean) => (dark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME).background;

const rootIsDark = () => typeof document !== "undefined" && document.documentElement.classList.contains("dark");

/** True when the app currently renders dark. Falls back to the root class before next-themes resolves. */
export function useTerminalDark(): boolean {
    const { resolvedTheme } = useTheme();
    const [fallback, setFallback] = useState(rootIsDark);
    useEffect(() => { setFallback(rootIsDark()); }, [resolvedTheme]);
    return resolvedTheme ? resolvedTheme === "dark" : fallback;
}
