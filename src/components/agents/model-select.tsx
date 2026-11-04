import { providerThemeProps } from "@/lib/provider-theme";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ModelOption } from "@/lib/runtime/types";
import IconBrandClaude from "@/components/ui/brand/IconBrandClaude";
import IconBrandCodex from "@/components/ui/brand/IconBrandCodex";
import type { LoginProviderId } from "@/lib/runtime/types";
import { IconAdjustments, IconBolt, IconBrain, IconEye, IconRoute, IconScale, IconSettings, IconSparkles } from "@tabler/icons-react";

export interface ModelChoice {
    /** "" means "use the CLI's default" (nothing is sent). */
    value: string;
    label: string;
    description?: string;
}

/** The runtime may already list a default entry; never show two. */
export function normalizeModels(models: ModelOption[] | undefined): ModelChoice[] {
    if (!models || models.length === 0) return [];
    const list: ModelChoice[] = [];
    let hasDefault = false;
    for (const m of models) {
        if (!m.id || m.id === "default") {
            if (hasDefault) continue;
            hasDefault = true;
            list.unshift({ value: "", label: m.label || "Default", description: m.description });
        } else {
            list.push({ value: m.id, label: m.label, description: m.description });
        }
    }
    if (!hasDefault) list.unshift({ value: "", label: "Default" });
    return list;
}

const DESCRIPTIONS: Record<string, string> = {
    default: "Uses the CLI's default model",
    opus: "Most capable",
    sonnet: "Balanced speed and quality",
    haiku: "Fastest",
    opusplan: "Opus for planning, Sonnet for execution",
    "opus plan": "Opus for planning, Sonnet for execution",
    "gpt-6-astra": "For demanding, deep work",
    "gpt-6.1-sol": "Balanced for complex work",
    "gpt-6.1-terra": "Strong visual reasoning",
    "gpt-6-luna": "Efficient for focused tasks",
    "gpt-6-sol": "Previous generation",
    "gpt-5.6-sol": "Balanced for complex work",
    "gpt-5.6-terra": "Strong visual reasoning",
    "gpt-5.6-luna": "Efficient for focused tasks",
    "gpt-5.5": "Previous generation general model",
    "gpt-5.4": "Previous generation general model",
    "gpt-5.3-codex": "Previous generation coding model",
    "gpt-5.1-codex-max": "Previous generation coding model",
};

function modelIcon(choice: ModelChoice) {
    const id = choice.value.toLowerCase();
    if (!id || id === "default") return IconSettings;
    if (id.includes("opusplan") || id.includes("plan")) return IconRoute;
    if (id.includes("astra") || id.includes("opus")) return IconBrain;
    if (id.includes("luna") || id.includes("haiku")) return IconBolt;
    if (id.includes("terra")) return IconEye;
    if (id.includes("sonnet") || id.includes("sol")) return IconScale;
    if (id.includes("codex")) return IconSparkles;
    return IconAdjustments;
}

/** Known models get a one-line description; anything else gets none (nothing is invented). */
function describe(choice: ModelChoice): string | null {
    if (choice.description) return choice.description;
    const key = choice.value === "" ? "default" : choice.value.toLowerCase();
    return DESCRIPTIONS[key] ?? DESCRIPTIONS[choice.label.toLowerCase()] ?? (choice.value ? "Custom model" : null);
}

interface Props {
    options: ModelChoice[];
    value: string;
    onChange: (value: string) => void;
    /** "field" fills the width (dialogs); "compact" is a ghost button (composer toolbar). */
    variant?: "field" | "compact";
    provider: LoginProviderId;
    disabled?: boolean;
}

export default function ModelSelect({ options, value, onChange, variant = "field", provider, disabled = false }: Props) {
    const selected = options.find((o) => o.value === value) ?? options[0];
    const compact = variant === "compact";
    const BrandIcon = provider === "claude" ? IconBrandClaude : IconBrandCodex;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                {compact ? (
                    <Button variant="ghost" size="sm" className="text-muted-foreground" aria-label="Model" disabled={disabled}>
                        <BrandIcon {...providerThemeProps(provider)} className="size-3.5 text-(--provider-accent)" />
                        {selected?.label}
                        <IconChevronDown className="size-3" />
                    </Button>
                ) : (
                    // A form field, not a toolbar button: flat (no Glisse glass, whose hover tint and
                    // centred layout are tuned for buttons) and styled like SelectTrigger so it matches
                    // the Role select and Title input.
                    <Button
                        variant="outline"
                        glisse={false}
                        className="h-8 w-full justify-between rounded-lg border-input bg-transparent pr-2 pl-2.5 font-normal text-foreground transition-colors hover:bg-muted/70 active:bg-muted aria-expanded:border-ring dark:focus-visible:border-ring dark:aria-expanded:border-ring aria-expanded:bg-transparent dark:bg-input/30 dark:hover:bg-input/50 dark:active:bg-input/60 dark:aria-expanded:bg-input/30"
                        aria-label="Model"
                        disabled={disabled}
                    >
                        <span className="flex min-w-0 items-center gap-2"><BrandIcon {...providerThemeProps(provider)} className="size-4 shrink-0 text-(--provider-accent)" /><span className="truncate">{selected?.label}</span></span>
                        <IconChevronDown className="size-4 text-muted-foreground" />
                    </Button>
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align={compact ? "end" : "start"}
                sideOffset={4}
                className={
                    compact
                        ? "max-h-72 w-max max-w-[340px] min-w-[240px] overflow-y-auto"
                        : "max-h-72 w-(--radix-dropdown-menu-trigger-width) overflow-y-auto"
                }
            >
                {options.map((option) => {
                    const description = describe(option);
                    const ModelIcon = modelIcon(option);
                    return (
                        <DropdownMenuItem key={option.value || "default"} onClick={() => onChange(option.value)} className="gap-2">
                            {option.value === (selected?.value ?? "")
                                ? <IconCheck {...providerThemeProps(provider)} className="size-4 shrink-0 text-(--provider-accent)" />
                                : <span aria-hidden="true" className="size-4 shrink-0" />}
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate">{option.label}</span>
                                {description && <span className="whitespace-normal text-xs leading-snug text-muted-foreground">{description}</span>}
                            </span>
                            <ModelIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
