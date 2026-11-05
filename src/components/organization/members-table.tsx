import { useState } from "react";
import { IconUserMinus } from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import { ROLE_LABEL } from "@/lib/organizations";
import type { Organization, OrganizationMember } from "@/lib/runtime/types";
import { ConfirmDialog } from "./confirm-dialog";

export function MembersTable({ organization }: { organization: Organization }) {
    const client = useClient();
    const { user, refreshOrganizations } = useRuntime();
    const [removing, setRemoving] = useState<OrganizationMember | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const isOwner = organization.role === "owner";

    // Admins may remove plain members only; owners may remove anyone but themselves. The runtime re-checks every call.
    const canRemove = (member: OrganizationMember) =>
        member.id !== user?.id && member.role !== "owner" && (isOwner || (organization.role === "admin" && member.role === "member"));

    async function changeRole(member: OrganizationMember, role: "admin" | "member") {
        setBusyId(member.id);
        try {
            await client.setOrganizationMemberRole(organization.id, member.id, role);
            await refreshOrganizations(organization.id);
            toast.success(`${member.name || member.email} is now ${ROLE_LABEL[role].toLowerCase()}`, { description: "The new role applies immediately." });
        } catch (reason) {
            toast.error("Could not change the role", { description: errorMessage(reason) });
        } finally {
            setBusyId(null);
        }
    }

    return (
        <>
            <Table aria-label={`Members of ${organization.name}`}>
                <TableHeader>
                    <TableRow>
                        <TableHead>Member</TableHead>
                        <TableHead className="w-36">Role</TableHead>
                        <TableHead className="w-12"><span className="sr-only">Actions</span></TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {organization.members.map((member) => {
                        const you = member.id === user?.id;
                        const roleEditable = isOwner && !you && member.role !== "owner";
                        return (
                            <TableRow key={member.id}>
                                <TableCell className="max-w-0">
                                    <div className="flex min-w-0 flex-col">
                                        <span className="truncate text-sm font-medium">{member.name || member.email}{you && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}</span>
                                        {member.name && <span className="truncate text-xs text-muted-foreground">{member.email}</span>}
                                    </div>
                                </TableCell>
                                <TableCell>
                                    {roleEditable ? (
                                        <NativeSelect size="sm" aria-label={`Role for ${member.name || member.email}`} value={member.role} disabled={busyId === member.id} onChange={(e) => void changeRole(member, e.target.value as "admin" | "member")}>
                                            <option value="admin">Admin</option>
                                            <option value="member">Member</option>
                                        </NativeSelect>
                                    ) : (
                                        <Badge variant={member.role === "owner" ? "default" : "outline"}>{ROLE_LABEL[member.role]}</Badge>
                                    )}
                                </TableCell>
                                <TableCell>
                                    {canRemove(member) && (
                                        <Button size="icon-sm" variant="ghost" aria-label={`Remove ${member.name || member.email}`} onClick={() => setRemoving(member)}>
                                            <IconUserMinus aria-hidden="true" />
                                        </Button>
                                    )}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
            <ConfirmDialog
                open={removing !== null}
                onOpenChange={(open) => { if (!open) setRemoving(null); }}
                title={`Remove ${removing?.name || removing?.email || "member"}?`}
                description="They lose access to this organization immediately. You can invite them again later."
                actionLabel="Remove member"
                onConfirm={async () => {
                    if (!removing) return;
                    await client.removeOrganizationMember(organization.id, removing.id);
                    await refreshOrganizations(organization.id);
                    toast.success(`Removed ${removing.name || removing.email}`, { description: "They no longer have access to this organization." });
                }}
            />
        </>
    );
}
