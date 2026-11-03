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
        <SettingsPage title="Performance" description="Tune terminal history and interface motion. These preferences are stored on this device only.">
            <SettingsGroup title="Terminal memory">
                <SettingRow
                    label="History profile"
                    description={
                        prefs.mode === "automatic"
                            ? `Automatic currently keeps ${currentLimit.toLocaleString()} lines per terminal. It uses a coarse browser memory hint when available; otherwise it uses the balanced limit.`
                            : "Each open terminal keeps this many lines for scrollback and search."
                    }
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
                <p className="px-4 pb-3 text-xs text-muted-foreground">
                    Choosing a profile with a smaller limit trims the oldest lines from open terminals immediately. Less history means less memory, but less output to review and search.
                </p>
                {prefs.mode === "custom" && (
                    <SettingRow
                        label="Scrollback lines"
                        description="Reducing this limit immediately drops older lines from open terminals."
                    >
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
                <div className="px-4 pb-4 text-xs text-muted-foreground">
                    Low memory keeps 2,500 lines per terminal. Balanced keeps 10,000. Automatic selects 2,500 only when the browser reports under 8 GB; some desktop WebViews do not expose this hint, so Automatic may use the balanced limit. Floq cannot read exact device RAM.
                </div>
            </SettingsGroup>

            <SettingsGroup title="Interface">
                <SettingRow
                    label="Reduce interface motion"
                    htmlFor="performance-reduce-motion"
                    description="Stops decorative transitions and animations across Floq. Terminal cursor blink is controlled in Appearance."
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
                    description="Adds a brief 100 ms animation when terminal output scrolls. This affects feel, not memory use."
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
                    description="While this window is hidden, refreshes session and project status every 30 seconds instead of every 5. Status may be less current until you return."
                >
                    <Switch
                        id="performance-background-refresh"
                        checked={prefs.reduceBackgroundRefresh}
                        onCheckedChange={(reduceBackgroundRefresh) => setPrefs({ reduceBackgroundRefresh })}
                    />
                </SettingRow>
            </SettingsGroup>
            <p className="text-xs text-muted-foreground">
                Terminal tabs stay mounted so their live output and scrollback remain available. Lower history limits reduce memory use but also shorten how far back you can review or search.
            </p>
        </SettingsPage>
    );
}
