import { useEffect, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useTheme } from "next-themes";

/** A native window material the shell can apply (src-tauri `set_native_material`). */
export type NativeMaterial = "mica" | "acrylic" | "vibrancy" | "none";
/** The user-facing preference (src/lib/material-preference.ts). */
export type MaterialChoice = "mica" | "acrylic" | "solid";

function normalize(value: unknown): NativeMaterial {
  return value === "mica" || value === "acrylic" || value === "vibrancy" ? value : "none";
}

// --- What this platform supports: Win11 [mica, acrylic], Win10 >= 1809 [acrylic], macOS [vibrancy], else []. ---
let support: readonly NativeMaterial[] | null = isTauri() ? null : [];
const supportListeners = new Set<() => void>();
if (support === null) {
  void invoke<unknown>("native_material_support")
    .then((value) => (Array.isArray(value) ? value.map(normalize).filter((m) => m !== "none") : []))
    .catch(() => [] as NativeMaterial[])
    .then((list) => {
      support = list;
      supportListeners.forEach((listener) => listener());
    });
}

/** The supported native materials, or null while the shell is still being asked. */
export function useNativeMaterialSupport(): readonly NativeMaterial[] | null {
  return useSyncExternalStore(
    (listener) => { supportListeners.add(listener); return () => { supportListeners.delete(listener); }; },
    () => support,
    () => null,
  );
}

/** Default preference when nothing valid is stored: Mica (vibrancy on macOS) where available, otherwise Solid. */
export function defaultMaterialChoice(list: readonly NativeMaterial[] | null): MaterialChoice {
  // Unknown yet: assume the translucent default so the preference does not flip on Win11/macOS; the native
  // call is held until the list arrives, so nothing is applied on an unsupported platform.
  if (list === null) return "mica";
  return list.includes("mica") || list.includes("vibrancy") ? "mica" : "solid";
}

/** Maps the preference to the material the shell should apply on this platform ("none" if unsupported). */
export function nativeMaterialFor(choice: MaterialChoice, list: readonly NativeMaterial[]): NativeMaterial {
  if (choice === "solid") return "none";
  if (list.includes("vibrancy")) return "vibrancy";
  return list.includes(choice) ? choice : "none";
}

/** `<html data-native-material>` is set only for an applied effect; CSS makes the shell translucent only under it. */
function applyAttribute(material: NativeMaterial) {
  const root = document.documentElement;
  if (material === "none") delete root.dataset.nativeMaterial;
  else root.dataset.nativeMaterial = material;
}

/** Bumped on every set_native_material request; stale results are dropped. */
let generation = 0;

/**
 * Keeps the native window material in sync with the Material preference and the app theme.
 * No-op outside Tauri, so the browser build always stays solid.
 */
export function useNativeMaterial(choice: MaterialChoice) {
  const { theme = "system", resolvedTheme } = useTheme();
  const list = useNativeMaterialSupport();

  useEffect(() => {
    if (!isTauri() || list === null) return;
    const material = nativeMaterialFor(choice, list);
    // Before the theme resolves, follow the OS; next-themes reports it on the next render.
    const forcedTheme = theme === "system" || !resolvedTheme ? null : resolvedTheme;
    const request = ++generation;
    void invoke<unknown>("set_native_material", { material, theme: forcedTheme })
      .then(normalize, () => "none" as const)
      .then((applied) => {
        // Only the latest request wins, so a slow earlier call cannot undo a newer setting.
        if (request === generation) applyAttribute(applied);
      });
  }, [choice, list, theme, resolvedTheme]);
}
