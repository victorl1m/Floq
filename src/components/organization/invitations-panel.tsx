import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { IconCheck, IconCopy, IconMailOff, IconMailPlus, IconRefresh, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/app-dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { errorMessage, useClient } from "@/lib/runtime/store";
import { ROLE_LABEL, formatExpiry } from "@/lib/organizations";
import type { IssuedOrganizationInvitation, Organization, OrganizationInvitation } from "@/lib/runtime/types";

/**
 * Delivery is manual: the runtime has no email transport, so nothing is emailed. The invited address sees the
 * invitation in its account menu after signing in, and the code below can be sent through any channel.
 */
export function InvitationsPanel({ organization }: { organization: Organization }) {
    const client = useClient();
    const ids = { email: useId(), role: useId() };
    const [invitations, setInvitations] = useState<OrganizationInvitation[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<"admin" | "member">("member");
    const [sending, setSending] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [issued, setIssued] = useState<IssuedOrganizationInvitation | null>(null);
    const [copied, setCopied] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const isOwner = organization.role === "owner";

    const load = useCallback(async () => {
        try {
            setInvitations(await client.organizationInvitations(organization.id));
            setLoadError(null);
        } catch (reason) {
            setLoadError(errorMessage(reason));
        }
    }, [client, organization.id]);

    useEffect(() => { setInvitations(null); setIssued(null); void load(); }, [load]);

    async function copy(token: string) {
        try {
            await navigator.clipboard.writeText(token);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            toast.error("Could not copy the code", { description: "Select the code and copy it manually." });
        }
    }

    async function invite(event: FormEvent) {
        event.preventDefault();
        if (!email.trim() || sending) return;
        setSending(true);
        setFormError(null);
        try {
            const created = await client.createOrganizationInvitation(organization.id, email.trim(), role);
            setIssued(created);
            setEmail("");
            await load();
        } catch (reason) {
            setFormError(errorMessage(reason));
        } finally {
            setSending(false);
        }
    }

    async function act(invitation: OrganizationInvitation, action: "resend" | "cancel") {
        setBusyId(invitation.id);
        try {
            if (action === "resend") {
                setIssued(await client.resendOrganizationInvitation(organization.id, invitation.id));
                toast.success("New code issued", { description: "The previous code no longer works." });
            } else {
                await client.cancelOrganizationInvitation(organization.id, invitation.id);
                setInvitations((current) => current?.filter((entry) => entry.id !== invitation.id) ?? current);
                toast(`Cancelled the invitation for ${invitation.email}`, { icon: <IconMailOff className="size-4" aria-hidden="true" />, description: "Its code no longer works." });
            }
            await load();
        } catch (reason) {
            toast.error(action === "resend" ? "Could not resend the invitation" : "Could not cancel the invitation", { description: errorMessage(reason) });
            void load();
        } finally {
            setBusyId(null);
        }
    }

    return (
        <div className="flex flex-col gap-4 p-4">
            <form onSubmit={invite} className="flex flex-col gap-2 sm:flex-row sm:items-end" noValidate>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <label htmlFor={ids.email} className="text-sm font-medium">Invite by email</label>
                    <Input id={ids.email} type="email" inputMode="email" value={email} placeholder="name@company.com" autoCapitalize="none" spellCheck={false} aria-describedby={formError ? `${ids.email}-error` : undefined} aria-invalid={formError ? true : undefined} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                    <label htmlFor={ids.role} className="text-sm font-medium">Role</label>
                    <NativeSelect id={ids.role} value={role} onChange={(e) => setRole(e.target.value as "admin" | "member")}>
                        <option value="member">Member</option>
                        {isOwner && <option value="admin">Admin</option>}
                    </NativeSelect>
                </div>
                <Button type="submit" loading={sending} disabled={!email.trim()}><IconMailPlus aria-hidden="true" />Invite</Button>
            </form>
            <p className="text-xs leading-relaxed text-muted-foreground">
                Floq does not send email. The invited address sees the invitation in its account menu after it signs in, and you can also share the one-time code.
                Invitations expire after 7 days.
            </p>
            <div aria-live="assertive" id={`${ids.email}-error`}>{formError && <ErrorBanner>{formError}</ErrorBanner>}</div>

            {issued && (
                <div role="status" className="flex flex-col gap-2 rounded-xl border border-border bg-muted/40 p-3">
                    <p className="text-sm">One-time code for <span className="font-medium">{issued.email}</span>. It is shown only now.</p>
                    <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-xs select-all">{issued.token}</code>
                        <Button type="button" size="sm" variant="outline" onClick={() => void copy(issued.token)}>
                            {copied ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}{copied ? "Copied" : "Copy code"}
                        </Button>
                        <Button type="button" size="icon-sm" variant="ghost" aria-label="Dismiss code" onClick={() => setIssued(null)}><IconX aria-hidden="true" /></Button>
                    </div>
                </div>
            )}

            <div className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Pending{invitations ? ` · ${invitations.length}` : ""}</h3>
                {loadError ? (
                    <div className="flex items-center gap-2"><ErrorBanner>{loadError}</ErrorBanner><Button size="sm" variant="outline" onClick={() => void load()}><IconRefresh aria-hidden="true" />Retry</Button></div>
                ) : invitations === null ? (
                    <p className="text-sm text-muted-foreground" aria-busy="true">Loading invitations…</p>
                ) : invitations.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No pending invitations. Invite someone above.</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
                        {invitations.map((invitation) => {
                            const canAct = isOwner || invitation.role === "member";
                            return (
                                <li key={invitation.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">{invitation.email}</p>
                                        <p className="truncate text-xs text-muted-foreground">Invited by {invitation.invitedBy} · {formatExpiry(invitation.expiresAt)}</p>
                                    </div>
                                    <Badge variant="outline">{ROLE_LABEL[invitation.role]}</Badge>
                                    <Badge variant={invitation.status === "expired" ? "destructive" : "secondary"}>{invitation.status === "expired" ? "Expired" : "Pending"}</Badge>
                                    {canAct && (
                                        <div className="flex gap-1">
                                            <Button size="sm" variant="ghost" disabled={busyId === invitation.id} aria-label={`Resend invitation to ${invitation.email}`} onClick={() => void act(invitation, "resend")}><IconRefresh aria-hidden="true" />Resend</Button>
                                            <Button size="sm" variant="ghost" disabled={busyId === invitation.id} aria-label={`Cancel invitation to ${invitation.email}`} onClick={() => void act(invitation, "cancel")}>Cancel</Button>
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
}
