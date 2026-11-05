import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { AdminUser, UserRole } from "@/lib/runtime/admin-types";
import { SettingRow, SettingsGroup, SettingsPage } from "./ui";

/** Administrator-only user list with promote/demote. The server enforces the admin check and the last-admin rule. */
export default function UsersSection() {
    const { client } = useRuntime();
    const [users, setUsers] = useState<AdminUser[] | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [pending, setPending] = useState<{ user: AdminUser; role: UserRole } | null>(null);

    const load = useCallback(async () => {
        if (!client) return;
        try {
            setUsers(await client.adminUsers());
        } catch (e) {
            toast.error("Could not load users", { description: errorMessage(e) });
        }
    }, [client]);

    useEffect(() => {
        void load();
    }, [load]);

    async function change(user: AdminUser, role: UserRole) {
        if (!client) return;
        setBusyId(user.id);
        try {
            await client.setUserRole(user.id, role);
            toast.success(role === "admin" ? `${user.name} is now an administrator` : `${user.name} is no longer an administrator`, {
                description: role === "admin" ? "They can manage users and settings." : "They can no longer manage users or settings.",
            });
            await load();
        } catch (e) {
            toast.error("Could not change role", { description: errorMessage(e) });
        } finally {
            setBusyId(null);
        }
    }

    return (
        <SettingsPage title="Users" description="Everyone with an account on this runtime. Administrators can manage users and update the runtime.">
            <SettingsGroup>
                {!users && (
                    <div className="flex justify-center p-6">
                        <Spinner />
                    </div>
                )}
                {users?.map((user) => (
                    <SettingRow
                        key={user.id}
                        label={
                            <span className="flex items-center gap-2">
                                {user.name}
                                {user.role === "admin" && <Badge>Administrator</Badge>}
                            </span>
                        }
                        description={`${user.email} - joined ${new Date(user.createdAt).toLocaleDateString()}${user.lastActiveAt ? ` - active ${new Date(user.lastActiveAt).toLocaleDateString()}` : ""}`}
                    >
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={busyId !== null}
                            onClick={() => setPending({ user, role: user.role === "admin" ? "member" : "admin" })}
                        >
                            {busyId === user.id && <Spinner />}
                            {user.role === "admin" ? "Remove administrator" : "Make administrator"}
                        </Button>
                    </SettingRow>
                ))}
            </SettingsGroup>
            <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{pending?.role === "admin" ? "Make administrator?" : "Remove administrator?"}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {pending?.role === "admin"
                                ? `${pending.user.name} will be able to manage users and update the runtime.`
                                : `${pending?.user.name} will lose access to user management and updates.`}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                const p = pending;
                                setPending(null);
                                if (p) void change(p.user, p.role);
                            }}
                        >
                            Confirm
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </SettingsPage>
    );
}
