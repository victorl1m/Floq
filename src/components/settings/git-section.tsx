import { useState } from "react";
import { IconBrandGithub } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import type { UserSettings } from "@/lib/runtime/types";
import { GithubFlowPanel, useGithubDeviceFlow } from "./github-device-flow";
import { SavedCheck, SettingRow, SettingsGroup, SettingsPage, useSavedFlash } from "./ui";

interface Props {
    settings: UserSettings;
    onChange: (settings: UserSettings) => void;
    reload: () => Promise<void>;
}

function GitField({
    id,
    label,
    description,
    placeholder,
    type,
    stored,
    field,
    onChange,
}: {
    id: string;
    label: string;
    description: string;
    placeholder: string;
    type?: string;
    stored: string | null;
    field: "gitName" | "gitEmail";
    onChange: (settings: UserSettings) => void;
}) {
    const client = useClient();
    const [value, setValue] = useState(stored ?? "");
    const [saved, flash] = useSavedFlash();

    async function save() {
        const next = value.trim();
        if (next === (stored ?? "")) return;
        try {
            onChange(await client.updateSettings({ [field]: next || null }));
            flash();
        } catch (e) {
            toast.error(`Could not save the ${label.toLowerCase()}`, { description: errorMessage(e) });
            setValue(stored ?? "");
        }
    }

    return (
        <SettingRow label={label} description={description} htmlFor={id}>
            <SavedCheck show={saved} />
            <Input
                id={id}
                type={type}
                className="w-56"
                placeholder={placeholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onBlur={() => void save()}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
        </SettingRow>
    );
}

function GithubRow({ settings, reload }: { settings: UserSettings; reload: () => Promise<void> }) {
    const client = useClient();
    const { info } = useRuntime();
    const device = useGithubDeviceFlow(reload);

    if (info && !info.githubConfigured) {
        return (
            <SettingRow
                label="GitHub"
                description="GitHub is not configured on this runtime. Ask the operator to set a GitHub OAuth client id."
            />
        );
    }

    async function disconnect() {
        try {
            await client.githubDisconnect();
            toast.success("GitHub disconnected", { description: "Connect again to clone private repositories." });
            await reload();
        } catch (e) {
            toast.error("Could not disconnect", { description: errorMessage(e) });
        }
    }

    if (device.flow) {
        return (
            <div className="p-4">
                <GithubFlowPanel flow={device.flow} onCancel={device.cancel} />
            </div>
        );
    }

    return settings.github ? (
        <SettingRow
            label="GitHub"
            description={
                <span className="flex items-center gap-1.5">
                    <IconBrandGithub className="size-3.5" />
                    Connected as <span className="font-medium text-foreground">{settings.github.login}</span>
                </span>
            }
        >
            <Button variant="outline" size="sm" onClick={() => void disconnect()}>
                Disconnect
            </Button>
        </SettingRow>
    ) : (
        <SettingRow label="GitHub" description="Connect GitHub so agents can clone private repositories and push.">
            <Button size="sm" disabled={device.starting} onClick={() => void device.start()}>
                {device.starting ? <Spinner /> : <IconBrandGithub />}
                Connect
            </Button>
        </SettingRow>
    );
}

export default function GitSection({ settings, onChange, reload }: Props) {
    const { user } = useRuntime();
    const login = settings.github?.login;
    const namePlaceholder = login ?? user?.name ?? "Your name";
    const emailPlaceholder = login ? `${login}@users.noreply.github.com` : (user?.email ?? "you@example.com");
    return (
        <SettingsPage title="Git & GitHub" description="Identity used for commits and access to your repositories.">
            <SettingsGroup title="Git identity">
                <GitField
                    id="git-name"
                    label="Name"
                    description="Author name on commits made by agents."
                    placeholder={namePlaceholder}
                    stored={settings.gitName}
                    field="gitName"
                    onChange={onChange}
                />
                <GitField
                    id="git-email"
                    label="Email"
                    description="Author email on commits made by agents."
                    placeholder={emailPlaceholder}
                    type="email"
                    stored={settings.gitEmail}
                    field="gitEmail"
                    onChange={onChange}
                />
            </SettingsGroup>
            <SettingsGroup title="GitHub">
                <GithubRow settings={settings} reload={reload} />
            </SettingsGroup>
        </SettingsPage>
    );
}
