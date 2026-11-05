import { useEffect, useState } from "react";
import { IconLogout, IconMailOpened, IconPlus, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ConfirmDialog } from "@/components/organization/confirm-dialog";
import { InvitationsPanel } from "@/components/organization/invitations-panel";
import { MembersTable } from "@/components/organization/members-table";
import { OrganizationAvatar } from "@/components/organization/organization-avatar";
import { canManageMembers, organizationUi, ROLE_LABEL, ROLE_SUMMARY, useOrganizationUi } from "@/lib/organizations";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import { SavedCheck, SettingRow, SettingsGroup, SettingsPage, useSavedFlash } from "./ui";

export default function OrganizationSection() {
    const client = useClient();
    const { organizations, organizationsLoading, organizationsError, activeOrganizationId, refreshOrganizations, user } = useRuntime();
    const { incoming } = useOrganizationUi();
    const org = organizations.find((organization) => organization.id === activeOrganizationId) ?? null;
    const [name, setName] = useState(org?.name ?? "");
    const [saved, flash] = useSavedFlash();
    const [leaveOpen, setLeaveOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [transferTo, setTransferTo] = useState("");
    const [transferOpen, setTransferOpen] = useState(false);
    const isOwner = org?.role === "owner";

    useEffect(() => setName(org?.name ?? ""), [org?.id, org?.name]);
    useEffect(() => setTransferTo(""), [org?.id]);

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

    const otherMembers = org?.members.filter((member) => member.id !== user?.id) ?? [];
    const transferTarget = otherMembers.find((member) => member.id === transferTo);

    return (
        <SettingsPage title="Organization" description="Organizations belong to your account and follow you to every device. Switch the active one from the account menu in the sidebar.">
            <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={organizationUi.openCreate}><IconPlus aria-hidden="true" />Create organization</Button>
                {incoming.length > 0 && (
                    <Button variant="outline" onClick={organizationUi.openInbox}><IconMailOpened aria-hidden="true" />{incoming.length} pending invitation{incoming.length === 1 ? "" : "s"}</Button>
                )}
            </div>

            {!org ? (
                <div className="material-content flex flex-col items-start gap-3 rounded-2xl p-5" aria-busy={organizationsLoading}>
                    <p className="text-sm text-muted-foreground" role="status">
                        {organizationsLoading ? "Loading your organizations…" : organizationsError ? `Could not load organizations: ${organizationsError}` : "You are not in an organization yet. Create one, or accept an invitation."}
                    </p>
                    {!organizationsLoading && organizationsError && <Button size="sm" variant="outline" onClick={() => void refreshOrganizations()}>Retry</Button>}
                </div>
            ) : (
                <>
                    <SettingsGroup title="Overview">
                        <div className="flex items-center gap-3 p-4">
                            <OrganizationAvatar name={org.name} className="size-10 text-sm" />
                            <div className="min-w-0">
                                <p className="truncate text-sm font-semibold">{org.name}</p>
                                <p className="truncate font-mono text-xs text-muted-foreground">{org.slug}</p>
                            </div>
                        </div>
                        <SettingRow label="Name" description={isOwner ? "Shown across the app." : "Only the owner can rename the organization."} htmlFor="org-name">
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
                        <SettingRow label="URL name" description="Fixed when the organization is created.">
                            <span className="font-mono text-sm">{org.slug}</span>
                        </SettingRow>
                        <SettingRow label="Your role" description={ROLE_SUMMARY[org.role]}>
                            <span className="text-sm">{ROLE_LABEL[org.role]}</span>
                        </SettingRow>
                    </SettingsGroup>

                    <SettingsGroup title={`Members · ${org.members.length}`}>
                        <div className="p-2"><MembersTable organization={org} /></div>
                    </SettingsGroup>

                    {canManageMembers(org.role) ? (
                        <SettingsGroup title="Invitations"><InvitationsPanel organization={org} /></SettingsGroup>
                    ) : (
                        <p className="px-1 text-xs text-muted-foreground">Only owners and admins can invite people.</p>
                    )}

                    <SettingsGroup title="Leave or delete">
                        {isOwner ? (
                            <>
                                <SettingRow label="Transfer ownership" description="Owners cannot leave without handing the organization over. You become an admin." stack>
                                    <NativeSelect aria-label="New owner" value={transferTo} disabled={otherMembers.length === 0} onChange={(e) => setTransferTo(e.target.value)}>
                                        <option value="">{otherMembers.length ? "Choose a member…" : "No other members"}</option>
                                        {otherMembers.map((member) => <option key={member.id} value={member.id}>{member.name || member.email}</option>)}
                                    </NativeSelect>
                                    <Button variant="outline" disabled={!transferTo} onClick={() => setTransferOpen(true)}>Transfer</Button>
                                </SettingRow>
                                <SettingRow label="Delete organization" description="Permanently deletes the organization, its members list and its task boards. This cannot be undone.">
                                    <Button variant="destructive" onClick={() => setDeleteOpen(true)}>Delete organization</Button>
                                </SettingRow>
                            </>
                        ) : (
                            <SettingRow label="Leave organization" description="You lose access until someone invites you again.">
                                <Button variant="destructive" onClick={() => setLeaveOpen(true)}>Leave organization</Button>
                            </SettingRow>
                        )}
                    </SettingsGroup>

                    <ConfirmDialog
                        open={leaveOpen}
                        onOpenChange={setLeaveOpen}
                        title={`Leave ${org.name}?`}
                        description="You will lose access to this organization and its boards."
                        actionLabel="Leave organization"
                        onConfirm={async () => { await client.leaveOrganization(org.id); await refreshOrganizations(); toast(`You left ${org.name}`, { icon: <IconLogout className="size-4" aria-hidden="true" />, description: "You no longer have access to its projects." }); }}
                    />
                    <ConfirmDialog
                        open={deleteOpen}
                        onOpenChange={setDeleteOpen}
                        title={`Delete ${org.name}?`}
                        description="Every member loses access and all task boards in this organization are deleted. This cannot be undone."
                        requireText={org.name}
                        actionLabel="Delete organization"
                        onConfirm={async () => { await client.deleteOrganization(org.id, org.name); await refreshOrganizations(); toast(`Deleted ${org.name}`, { icon: <IconTrash className="size-4" aria-hidden="true" />, description: "Members lost access and its task boards were deleted." }); }}
                    />
                    <ConfirmDialog
                        open={transferOpen}
                        onOpenChange={setTransferOpen}
                        title={`Make ${transferTarget?.name || transferTarget?.email || "this member"} the owner?`}
                        description="They will be able to delete the organization and change roles. You become an admin."
                        actionLabel="Transfer ownership"
                        onConfirm={async () => { await client.transferOrganization(org.id, transferTo); await refreshOrganizations(org.id); setTransferTo(""); toast.success("Ownership transferred", { description: "The new owner now manages this organization." }); }}
                    />
                </>
            )}
        </SettingsPage>
    );
}
