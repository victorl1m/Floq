import { useTheme } from "next-themes";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useTerminalPrefs, type CursorStyle } from "@/lib/prefs";
import { SettingRow, SettingsGroup, SettingsPage } from "./ui";

export default function AppearanceSection() {
    const { theme = "system", setTheme } = useTheme();
    const [terminal, setTerminal] = useTerminalPrefs();

    return (
        <SettingsPage title="Appearance" description="Theme and terminal look. Stored on this device only.">
            <SettingsGroup title="App">
                <SettingRow label="Theme" description="Follow the system or force light or dark.">
                    <Select value={theme} onValueChange={setTheme}>
                        <SelectTrigger className="w-36">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="system">System</SelectItem>
                            <SelectItem value="light">Light</SelectItem>
                            <SelectItem value="dark">Dark</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>
            </SettingsGroup>

            <SettingsGroup title="Terminal">
                <SettingRow label="Font size" description="Applies to open terminals immediately.">
                    <span className="w-10 text-right text-sm tabular-nums text-muted-foreground">{terminal.fontSize}px</span>
                    <Slider
                        className="w-40"
                        min={11}
                        max={18}
                        step={1}
                        value={[terminal.fontSize]}
                        onValueChange={([v]) => setTerminal({ fontSize: v })}
                    />
                </SettingRow>
                <SettingRow label="Cursor style">
                    <Select value={terminal.cursorStyle} onValueChange={(v) => setTerminal({ cursorStyle: v as CursorStyle })}>
                        <SelectTrigger className="w-36">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="block">Block</SelectItem>
                            <SelectItem value="bar">Bar</SelectItem>
                            <SelectItem value="underline">Underline</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>
                <SettingRow label="Cursor blink">
                    <Switch checked={terminal.cursorBlink} onCheckedChange={(v) => setTerminal({ cursorBlink: v })} />
                </SettingRow>
            </SettingsGroup>
        </SettingsPage>
    );
}
