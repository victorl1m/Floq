import { useTheme } from "next-themes";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useTerminalPrefs, type CursorStyle } from "@/lib/prefs";
import { SettingRow, SettingsGroup, SettingsPage } from "./ui";
import { useCursorPreference } from "@/lib/cursor-preference";
import { useMaterialPreference, type MaterialPreference } from "@/lib/material-preference";

export default function AppearanceSection() {
    const { theme = "system", setTheme } = useTheme();
    const [terminal, setTerminal] = useTerminalPrefs();
    const [material, setMaterial] = useMaterialPreference();
    const [cursors, setCursors] = useCursorPreference();

    return (
        <SettingsPage title="Appearance" description="Theme and terminal look. Stored on this device only.">
            <SettingsGroup title="App">
                <SettingRow label="Material" htmlFor="appearance-material" description="Glass uses translucent surfaces. Follow system respects your device’s transparency preference.">
                    <Select value={material} onValueChange={(value) => setMaterial(value as MaterialPreference)}>
                        <SelectTrigger id="appearance-material" className="w-36"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="glass">Glass</SelectItem><SelectItem value="system">Follow system</SelectItem><SelectItem value="solid">Solid</SelectItem></SelectContent>
                    </Select>
                </SettingRow>
                <SettingRow label="Theme" htmlFor="appearance-theme" description="Follow the system or force light or dark.">
                    <Select value={theme} onValueChange={setTheme}>
                        <SelectTrigger id="appearance-theme" className="w-36">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="system">System</SelectItem>
                            <SelectItem value="light">Light</SelectItem>
                            <SelectItem value="dark">Dark</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>
                <SettingRow label="Custom cursors" htmlFor="appearance-custom-cursors" description="Floq’s own pointer set inside this window only. Turn off to use your system cursors. Terminals always keep the native cursor.">
                    <Switch id="appearance-custom-cursors" checked={cursors === "custom"} onCheckedChange={(v) => setCursors(v ? "custom" : "system")} />
                </SettingRow>
            </SettingsGroup>

            <SettingsGroup title="Terminal">
                <SettingRow label="Font size" description="Applies to open terminals immediately.">
                    <span className="w-10 text-right text-sm tabular-nums text-muted-foreground">{terminal.fontSize}px</span>
                    <Slider
                        aria-label="Terminal font size"
                        className="w-40"
                        min={11}
                        max={18}
                        step={1}
                        value={[terminal.fontSize]}
                        onValueChange={([v]) => setTerminal({ fontSize: v })}
                    />
                </SettingRow>
                <SettingRow label="Cursor style" htmlFor="appearance-cursor">
                    <Select value={terminal.cursorStyle} onValueChange={(v) => setTerminal({ cursorStyle: v as CursorStyle })}>
                        <SelectTrigger id="appearance-cursor" className="w-36">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="block">Block</SelectItem>
                            <SelectItem value="bar">Bar</SelectItem>
                            <SelectItem value="underline">Underline</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>
                <SettingRow label="Cursor blink" htmlFor="appearance-cursor-blink">
                    <Switch id="appearance-cursor-blink" checked={terminal.cursorBlink} onCheckedChange={(v) => setTerminal({ cursorBlink: v })} />
                </SettingRow>
            </SettingsGroup>
        </SettingsPage>
    );
}
