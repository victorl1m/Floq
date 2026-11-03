import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { effectiveScrollback, usePerformancePrefs } from "@/lib/prefs";
import { SettingRow, SettingsGroup, SettingsPage } from "./ui";

export default function PerformanceSection() {
    const [prefs, setPrefs] = usePerformancePrefs();
    const currentLimit = effectiveScrollback(prefs);

    function setMode(value: string) {
        if (value === "automatic" || value === "balanced" || value === "low-memory" || value === "custom") {
            setPrefs({ mode: value });
        }
    }

    return (
        <SettingsPage title="Performance" description="Choose terminal history and motion preferences. These settings are saved on this device.">
            <SettingsGroup title="Terminal memory">
                <div className="divide-y divide-border">
                    <SettingRow
                        label="History profile"
                        description={`${prefs.mode === "automatic" ? "Currently keeps" : "Keeps"} ${currentLimit.toLocaleString()} lines per terminal.`}
                    >
                        <Select value={prefs.mode} onValueChange={setMode}>
                            <SelectTrigger className="w-40" aria-label="Terminal history profile">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="automatic">Automatic</SelectItem>
                                <SelectItem value="balanced">Balanced</SelectItem>
                                <SelectItem value="low-memory">Low memory</SelectItem>
                                <SelectItem value="custom">Custom</SelectItem>
                            </SelectContent>
                        </Select>
                    </SettingRow>
                    {prefs.mode === "custom" && (
                        <SettingRow label="Scrollback lines" description="Older output is removed as new lines arrive.">
                            <span className="w-16 text-right text-sm tabular-nums text-muted-foreground">{prefs.scrollback.toLocaleString()}</span>
                            <Slider
                                className="w-40"
                                min={1_000}
                                max={20_000}
                                step={1_000}
                                value={[prefs.scrollback]}
                                aria-label="Terminal scrollback lines"
                                onValueChange={([value]) => setPrefs({ mode: "custom", scrollback: value })}
                            />
                        </SettingRow>
                    )}
                    <p className="px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                        Lower limits use less memory and keep less output available to review or search. Reducing the limit immediately removes the oldest terminal lines.
                    </p>
                </div>
            </SettingsGroup>

            <SettingsGroup title="Interface">
                <SettingRow
                    label="Reduce interface motion"
                    htmlFor="performance-reduce-motion"
                    description="Reduces interface transitions and animations. Terminal cursor blink follows Appearance."
                >
                    <Switch
                        id="performance-reduce-motion"
                        checked={prefs.reduceMotion}
                        onCheckedChange={(reduceMotion) => setPrefs({ reduceMotion })}
                    />
                </SettingRow>
                <SettingRow
                    label="Smooth terminal scrolling"
                    htmlFor="performance-smooth-terminal-scroll"
                    description="Adds a brief animation as new terminal output scrolls into view."
                >
                    <Switch
                        id="performance-smooth-terminal-scroll"
                        checked={prefs.smoothTerminalScrolling}
                        onCheckedChange={(smoothTerminalScrolling) => setPrefs({ smoothTerminalScrolling })}
                    />
                </SettingRow>
                <SettingRow
                    label="Reduce background refresh"
                    htmlFor="performance-background-refresh"
                    description="Checks session and project status every 30 seconds instead of 5 while the app is hidden."
                >
                    <Switch
                        id="performance-background-refresh"
                        checked={prefs.reduceBackgroundRefresh}
                        onCheckedChange={(reduceBackgroundRefresh) => setPrefs({ reduceBackgroundRefresh })}
                    />
                </SettingRow>
            </SettingsGroup>
        </SettingsPage>
    );
}
