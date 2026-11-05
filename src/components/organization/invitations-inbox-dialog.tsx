import { useState } from "react";
import { IconMailOff, IconMailOpened } from "@tabler/icons-react";
import { toast } from "sonner";
import { AppDialog, ErrorBanner } from "@/components/ui/app-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import { ROLE_LABEL, formatExpiry, organizationUi, useOrganizationUi } from "@/lib/organizations";
import { OrganizationAvatar } from "./organization-avatar";

/** Invitations addressed to the signed-in email. Accept or decline from here; both are applied by the runtime. */
export function InvitationsInboxDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const client = useClient();
    const { refreshOrganizations } = useRuntime();
    const { incoming } = useOrganizationUi();
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function respond(id: string, action: "accept" | "decline", organizationName: string) {
        setPending(`${action}:${id}`);
        setError(null);
        try {
            if (action === "accept") {
                const { organizationId } = await client.acceptIncomingOrganizationInvitation(id);
                organizationUi.removeIncoming(id);
                await refreshOrganizations(organizationId);
                toast.success(`You joined ${organizationName}`, { description: "It is now your active organization." });
            } else {
                await client.declineIncomingOrganizationInvitation(id);
                organizationUi.removeIncoming(id);
                toast(`Declined the invitation to ${organizationName}`, { icon: <IconMailOff className="size-4" aria-hidden="true" />, description: "Ask an admin to invite you again if you change your mind." });
            }
            if (organizationUi.snapshot().incoming.length === 0) onOpenChange(false);
        } catch (reason) {
            setError(errorMessage(reason));
            // The invitation may have expired or been cancelled meanwhile; resync the list.
            client.incomingOrganizationInvitations().then(organizationUi.setIncoming).catch(() => undefined);
        } finally {
            setPending(null);
        }
    }

    return (
        <AppDialog
            open={open}
            onOpenChange={onOpenChange}
            icon={<IconMailOpened aria-hidden="true" />}
            title="Pending invitations"
            description="People invited you to these organizations. Nothing changes until you accept."
            size="md"
            footer={<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>}
        >
            <div className="flex flex-col gap-3">
                <div aria-live="assertive">{error && <ErrorBanner>{error}</ErrorBanner>}</div>
                {incoming.length === 0 ? (
                    <Empty className="p-6">
                        <EmptyHeader>
                            <EmptyTitle>No pending invitations</EmptyTitle>
                            <EmptyDescription>When someone invites your email to an organization, it shows up here.</EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                ) : (
                    <ul className="flex flex-col gap-2" aria-label="Pending invitations">
                        {incoming.map((invite) => (
                            <li key={invite.id} className="flex items-center gap-3 rounded-xl border border-border p-3">
                                <OrganizationAvatar name={invite.organization.name} />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium">{invite.organization.name}</p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {invite.invitedBy} invited you as <Badge variant="outline" className="align-middle">{ROLE_LABEL[invite.role]}</Badge> · {formatExpiry(invite.expiresAt)}
                                    </p>
                                </div>
                                <div className="flex shrink-0 gap-2">
                                    <Button size="sm" variant="ghost" disabled={pending !== null} loading={pending === `decline:${invite.id}`} aria-label={`Decline invitation to ${invite.organization.name}`} onClick={() => void respond(invite.id, "decline", invite.organization.name)}>Decline</Button>
                                    <Button size="sm" disabled={pending !== null} loading={pending === `accept:${invite.id}`} aria-label={`Accept invitation to ${invite.organization.name}`} onClick={() => void respond(invite.id, "accept", invite.organization.name)}>Accept</Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </AppDialog>
    );
}

