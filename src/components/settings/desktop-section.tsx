import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Switch } from '@/components/ui/switch';
import { SettingRow, SettingsGroup } from './ui';

interface DesktopPreferences { keepRunningInBackground: boolean; islandEnabled: boolean; launchAtLogin: boolean }
export default function DesktopSection() {
  const [prefs, setPrefs] = useState<DesktopPreferences | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (isTauri()) void invoke<DesktopPreferences>('get_desktop_preferences').then(setPrefs).catch(e => setError(String(e))); }, []);
  async function change(key: keyof DesktopPreferences, checked: boolean) {
    if (!prefs || busy) return; setBusy(true); setError(undefined);
    try { const next = await invoke<DesktopPreferences>('set_desktop_preference', { preference: key, enabled: checked }); setPrefs(next); window.dispatchEvent(new CustomEvent('floq:desktop-preferences', { detail: next })); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <section className="space-y-5"><h2 className="text-lg font-semibold">Desktop</h2>{error && <p role="alert">{error}</p>}{!prefs && !error && <p>Loading desktop preferences…</p>}{prefs && <SettingsGroup>{([['keepRunningInBackground','Keep Floq running when closed'],['launchAtLogin','Start with Windows']] as const).map(([key,label]) => <SettingRow key={key} label={label} htmlFor={`desktop-${key}`}><Switch id={`desktop-${key}`} checked={prefs[key]} disabled={busy} onCheckedChange={v => void change(key,v)} /></SettingRow>)}</SettingsGroup>}</section>;
}
