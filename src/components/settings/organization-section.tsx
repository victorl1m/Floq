import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import { SavedCheck, SettingRow, SettingsGroup, SettingsPage, useSavedFlash } from "./ui";

export default function OrganizationSection() {
    const client = useClient();
    const { organizations, organizationsLoading, activeOrganizationId, refreshOrganizations } = useRuntime();
    const org = organizations.find((organization) => organization.id === activeOrganizationId) ?? null;
    const [name, setName] = useState(org?.name ?? "");
    const [saved, flash] = useSavedFlash();
    const isOwner = org?.role === "owner";

    useEffect(() => setName(org?.name ?? ""), [org?.id, org?.name]);

    async function saveName() {
        const next = name.trim();
        if (!org || !next || next === org.name) { setName(org?.name ?? ""); return; }
        try {
            await client.renameOrganization(org.id, next);
            await refreshOrganizations(org.id);
            flash();
        } catch (e) {
            toast.error("Could not rename the organization", { description: errorMessage(e) });
            setName(org.name);
        }
    }

    return (
        <SettingsPage title="Organization" description="The organization you're working in. Switch it from the user menu in the sidebar.">
            {!org ? (
                <p className="text-sm text-muted-foreground">{organizationsLoading ? "Loading…" : "You don't belong to an organization yet. Create one from Tasks."}</p>
            ) : (
                <>
                    <SettingsGroup>
                        <SettingRow label="Name" description={isOwner ? "Shown across the app." : "Only owners can rename the organization."} htmlFor="org-name">
                            <SavedCheck show={saved} />
                            <Input
                                id="org-name"
                                className="w-56"
                                maxLength={80}
                                value={name}
                                disabled={!isOwner}
                                onChange={(e) => setName(e.target.value)}
                                onBlur={() => void saveName()}
                                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                            />
                        </SettingRow>
                        <SettingRow label="Your role" description="Owners can rename the organization and invite people.">
                            <span className="text-sm capitalize">{org.role}</span>
                        </SettingRow>
                    </SettingsGroup>
                    <SettingsGroup title={`Members · ${org.members.length}`}>
                        {org.members.map((member) => (
                            <SettingRow key={member.id} label={member.name || member.email} description={member.name ? member.email : undefined}>
                                <span className="text-xs capitalize text-muted-foreground">{member.role}</span>
                            </SettingRow>
                        ))}
                    </SettingsGroup>
                </>
            )}
        </SettingsPage>
    );
}
