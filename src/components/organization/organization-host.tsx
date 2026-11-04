import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useRuntime } from "@/lib/runtime/store";
import { organizationUi, useOrganizationUi } from "@/lib/organizations";
import { CreateOrganizationDialog } from "./create-organization-dialog";
import { InvitationsInboxDialog } from "./invitations-inbox-dialog";

const POLL_MS = 60_000;

/**
 * Mounted once while signed in (inside the account menu's card). Keeps the invitation inbox fresh from the server
 * (poll + window focus), announces newly arrived invitations with a toast, and hosts the organization dialogs so the
 * account menu and Settings can open them without owning their state.
 */
export function OrganizationHost() {
    const { client, user } = useRuntime();
    const ui = useOrganizationUi();
    const seen = useRef<Set<string>>(new Set());
    const userId = user?.id ?? null;

    useEffect(() => {
        if (!client || !userId) return;
        let alive = true;
        seen.current = new Set();
        organizationUi.reset();
        const load = () => {
            client.incomingOrganizationInvitations().then((invitations) => {
                if (!alive) return;
                const fresh = invitations.filter((invite) => !seen.current.has(invite.id));
                invitations.forEach((invite) => seen.current.add(invite.id));
                organizationUi.setIncoming(invitations);
                if (fresh.length === 1) {
                    toast(`${fresh[0].invitedBy} invited you to ${fresh[0].organization.name}`, {
                        id: "organization-invitation",
                        action: { label: "Review", onClick: organizationUi.openInbox },
                    });
                } else if (fresh.length > 1) {
                    toast(`You have ${fresh.length} new organization invitations`, {
                        id: "organization-invitation",
                        action: { label: "Review", onClick: organizationUi.openInbox },
                    });
                }
            }).catch(() => undefined); // Offline or an older runtime: the badge simply stays empty.
        };
        load();
        const timer = setInterval(load, POLL_MS);
        const onFocus = () => load();
        window.addEventListener("focus", onFocus);
        return () => { alive = false; clearInterval(timer); window.removeEventListener("focus", onFocus); };
    }, [client, userId]);

    if (!client) return null;
    return (
        <>
            <CreateOrganizationDialog open={ui.createOpen} onOpenChange={organizationUi.setCreateOpen} />
            <InvitationsInboxDialog open={ui.inboxOpen} onOpenChange={organizationUi.setInboxOpen} />
        </>
    );
}
