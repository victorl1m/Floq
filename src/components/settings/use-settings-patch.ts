import { toast } from "sonner";
import { errorMessage, useClient } from "@/lib/runtime/store";
import type { SettingsPatch, UserSettings } from "@/lib/runtime/types";

/** Optimistic settings patch: flip locally, revert and toast if the server rejects it. */
export function useSettingsPatch(settings: UserSettings, onChange: (settings: UserSettings) => void) {
    const client = useClient();
    return async function patch(update: SettingsPatch & Partial<UserSettings>) {
        const previous = settings;
        onChange({ ...settings, ...update } as UserSettings);
        try {
            onChange(await client.updateSettings(update));
        } catch (e) {
            onChange(previous);
            toast.error("Could not save settings", { description: errorMessage(e) });
        }
    };
}
