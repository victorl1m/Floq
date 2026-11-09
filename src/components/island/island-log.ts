import { invoke, isTauri } from '@tauri-apps/api/core';

/** Diagnostic line into the native island.log (prefixed "ui "). Messages only: never request text, titles or answers. */
export function islandLog(message: string): void {
  if (!isTauri()) return;
  try { void invoke('island_log', { message }).catch(() => {}); } catch { /* ignore */ }
}
