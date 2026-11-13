import { useTheme } from "next-themes";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useTerminalPrefs, type CursorStyle } from "@/lib/prefs";
import { SettingRow, SettingsGroup, SettingsPage } from "./ui";
import { useAvatarPreference } from "@/lib/avatar-preference";
import { useCursorPreference } from "@/lib/cursor-preference";
import { useMaterialPreference, type MaterialPreference } from "@/lib/material-preference";
import { useNativeMaterialSupport } from "@/lib/native-material";

export default function AppearanceSection() {
    const { theme = "system", setTheme } = useTheme();
    const [terminal, setTerminal] = useTerminalPrefs();
    const [material, setMaterial] = useMaterialPreference();
    const [cursors, setCursors] = useCursorPreference();
    const [avatars, setAvatars] = useAvatarPreference();
    const support = useNativeMaterialSupport() ?? [];
    // macOS has one translucent material (vibrancy), stored as "mica". Windows lists what the build supports.
    const materialOptions: { value: MaterialPreference; label: string }[] = support.includes("vibrancy")
        ? [{ value: "mica", label: "Vibrancy" }]
        : [
            ...(support.includes("mica") ? [{ value: "mica" as const, label: "Mica" }] : []),
            ...(support.includes("acrylic") ? [{ value: "acrylic" as const, label: "Acrylic" }] : []),
        ];
    materialOptions.push({ value: "solid", label: "Solid" });
    // An unsupported stored value (e.g. Mica after moving to Windows 10) renders as Solid, which is what applies.
    const materialValue = support.includes("vibrancy") && material === "acrylic"
        ? "mica"
        : materialOptions.some((option) => option.value === material) ? material : "solid";
    const acrylicOnly = support.includes("acrylic") && !support.includes("mica");
    const materialDescription = support.length === 0
        ? "Translucent window materials need Windows 10 or later, or macOS. This window is solid."
        : `${support.includes("vibrancy") ? "Vibrancy lets" : acrylicOnly ? "Acrylic lets" : "Mica and Acrylic let"} the desktop show through the window shell. The window turns solid when transparency effects are off in your OS settings.${acrylicOnly ? " Acrylic may lag while moving or resizing the window." : ""}`;

    return (
        <SettingsPage title="Appearance" description="Theme and terminal look. Stored on this device only.">
            <SettingsGroup title="App">
                <SettingRow settingId="appearance-material" label="Material" htmlFor="appearance-material" description={materialDescription}>
                    <Select value={materialValue} onValueChange={(value) => setMaterial(value as MaterialPreference)} disabled={support.length === 0}>
                        <SelectTrigger id="appearance-material" className="w-36"><SelectValue /></SelectTrigger>
                        <SelectContent>{materialOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                </SettingRow>
                <SettingRow settingId="appearance-theme" label="Theme" htmlFor="appearance-theme" description="Follow the system or force light or dark.">
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
                <SettingRow settingId="appearance-cursors" label="Custom cursors" htmlFor="appearance-custom-cursors" description="Floq’s own pointer set inside this window only. Turn off to use your system cursors. Terminals always keep the native cursor.">
                    <Switch id="appearance-custom-cursors" checked={cursors === "custom"} onCheckedChange={(v) => setCursors(v ? "custom" : "system")} />
                </SettingRow>
                <SettingRow settingId="appearance-robot-avatars" label="Robot avatars" htmlFor="appearance-robot-avatars" description="Give each agent its own generated Floq avatar, with the provider logo as a small corner badge. Turn off to show the provider logo alone.">
                    <Switch id="appearance-robot-avatars" checked={avatars === "on"} onCheckedChange={(v) => setAvatars(v ? "on" : "off")} />
                </SettingRow>
            </SettingsGroup>

            <SettingsGroup title="Terminal">
                <SettingRow settingId="appearance-font-size" label="Font size" description="Applies to open terminals immediately.">
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
                <SettingRow settingId="appearance-cursor-style" label="Cursor style" htmlFor="appearance-cursor">
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
                <SettingRow settingId="appearance-cursor-blink" label="Cursor blink" htmlFor="appearance-cursor-blink">
                    <Switch id="appearance-cursor-blink" checked={terminal.cursorBlink} onCheckedChange={(v) => setTerminal({ cursorBlink: v })} />
                </SettingRow>
            </SettingsGroup>
        </SettingsPage>
    );
}
