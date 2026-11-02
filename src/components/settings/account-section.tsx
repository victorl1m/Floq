import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import { SavedCheck, SettingRow, SettingsGroup, SettingsPage, useSavedFlash } from "./ui";

const passwordSchema = z
    .object({
        currentPassword: z.string().min(1, "Enter your current password"),
        newPassword: z.string().min(12, "At least 12 characters.").max(128, "At most 128 characters."),
        confirm: z.string(),
    })
    .refine((v) => v.confirm === v.newPassword, { path: ["confirm"], message: "Passwords don't match" });
type PasswordValues = z.infer<typeof passwordSchema>;

function initials(label: string): string {
    const parts = label.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[1][0] ?? "") : "")).toUpperCase();
}

function ChangePassword() {
    const client = useClient();
    const form = useForm<PasswordValues>({
        resolver: zodResolver(passwordSchema),
        defaultValues: { currentPassword: "", newPassword: "", confirm: "" },
    });
    const { isSubmitting, errors } = form.formState;

    async function onSubmit(values: PasswordValues) {
        try {
            await client.changePassword(values.currentPassword, values.newPassword, false);
            toast.success("Password changed");
            form.reset();
        } catch (e) {
            form.setError("root", { message: errorMessage(e) });
        }
    }

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex w-full max-w-sm flex-col gap-3">
                {(["currentPassword", "newPassword", "confirm"] as const).map((name) => (
                    <FormField
                        key={name}
                        control={form.control}
                        name={name}
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>
                                    {name === "currentPassword" ? "Current password" : name === "newPassword" ? "New password" : "Confirm new password"}
                                </FormLabel>
                                <FormControl>
                                    <Input
                                        type="password"
                                        autoComplete={name === "currentPassword" ? "current-password" : "new-password"}
                                        {...field}
                                    />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                ))}
                {errors.root?.message && (
                    <p role="alert" className="text-sm text-destructive">
                        {errors.root.message}
                    </p>
                )}
                <div>
                    <Button type="submit" size="sm" disabled={isSubmitting}>
                        {isSubmitting && <Spinner />}
                        Change password
                    </Button>
                </div>
            </form>
        </Form>
    );
}

export default function AccountSection() {
    const client = useClient();
    const { user, patchUser, signOut } = useRuntime();
    const [name, setName] = useState(user?.name ?? "");
    const [saved, flash] = useSavedFlash();

    if (!user) return null;
    const label = user.name?.trim() || user.email.split("@")[0];

    async function saveName() {
        const next = name.trim();
        if (!next || next === user?.name) return;
        try {
            await client.updateName(next);
            patchUser({ name: next });
            flash();
        } catch (e) {
            toast.error("Could not update your name", { description: errorMessage(e) });
            setName(user?.name ?? "");
        }
    }

    return (
        <SettingsPage title="Account" description="Your profile and sign-in details.">
            <SettingsGroup>
                <div className="flex items-center gap-3 p-4">
                    <Avatar className="size-12">
                        <AvatarFallback className="text-base">{initials(label)}</AvatarFallback>
                    </Avatar>
                    <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{label}</span>
                        <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                    </div>
                </div>
                <SettingRow label="Name" description="Shown in the app and greetings." htmlFor="account-name">
                    <SavedCheck show={saved} />
                    <Input
                        id="account-name"
                        className="w-56"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onBlur={() => void saveName()}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    />
                </SettingRow>
                <SettingRow label="Email" description="Your sign-in address. It can't be changed here.">
                    <Input className="w-56" value={user.email} readOnly disabled />
                </SettingRow>
            </SettingsGroup>

            <SettingsGroup title="Password">
                <SettingRow label="Change password" description="Use at least 12 characters." stack>
                    <ChangePassword />
                </SettingRow>
            </SettingsGroup>

            <SettingsGroup title="Sessions">
                <SettingRow label="Sign out" description="Sign out of this device. Your terminals go to sleep.">
                    <Button variant="outline" size="sm" onClick={() => void signOut()}>
                        Sign out
                    </Button>
                </SettingRow>
            </SettingsGroup>
        </SettingsPage>
    );
}
