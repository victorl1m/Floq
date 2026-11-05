import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { IconArrowRight, IconCode, IconFolder, IconLock, IconServer, IconTerminal2 } from "@tabler/icons-react";
import { RuntimeClient, RuntimeError, normalizeBaseUrl } from "@/lib/runtime/client";
import { Button } from "@/components/ui/button";
import IconBrandFloq from "@/components/ui/brand/IconBrandFloq";
import IconBrandFlowless from "@/components/ui/brand/IconBrandFlowless";
import { FloqSurface } from "@/components/ui/floq-surface";
import IconBrandClaude from "@/components/ui/brand/IconBrandClaude";
import IconBrandCodex from "@/components/ui/brand/IconBrandCodex";
import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Spinner } from "@/components/ui/spinner";
import { defaultBaseUrl, useRuntime } from "@/lib/runtime/store";
import {
    MIN_PASSWORD,
    emailSchema,
    invitationRegistrationSchema,
    passwordSchema,
    setupSchema,
    type EmailValues,
    type InvitationRegistrationValues,
    type PasswordValues,
    type SetupValues,
} from "./schemas";

type Step = "email" | "password" | "setup" | "invite";

function hostOf(url: string): string {
    try {
        return new URL(normalizeBaseUrl(url)).host;
    } catch {
        return url;
    }
}

function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function RootError({ message }: { message?: string }) {
    if (!message) return null;
    return (
        <p role="alert" className="text-sm text-destructive">
            {message}
        </p>
    );
}

function SubmitButton({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
    return (
        <Button type="submit" size="lg" className="auth-submit w-full" shimmer disabled={busy || disabled}>
            {busy && <Spinner />}
            {children}
            {!busy && <IconArrowRight aria-hidden="true" className="ml-auto size-4" />}
        </Button>
    );
}

function EmailStep({
    initialUrl,
    initialEmail,
    onDone,
}: {
    initialUrl: string;
    initialEmail: string;
    onDone: (values: EmailValues, step: "password" | "setup") => void;
}) {
    const { lookup, changeServer } = useRuntime();
    const [editingUrl, setEditingUrl] = useState(initialUrl === "" || changeServer);
    const form = useForm<EmailValues>({
        resolver: zodResolver(emailSchema),
        defaultValues: { serverUrl: initialUrl, email: initialEmail },
    });
    const { isSubmitting, errors } = form.formState;
    const showUrl = editingUrl || Boolean(errors.serverUrl);

    async function onSubmit(values: EmailValues) {
        try {
            onDone(values, await lookup(values.serverUrl, values.email));
        } catch (e) {
            form.setError("root", { message: messageOf(e) });
        }
    }

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
                <div className="flex flex-col gap-4">
                    {showUrl ? (
                        <FormField
                            control={form.control}
                            name="serverUrl"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Runtime URL</FormLabel>
                                    <FormControl>
                                        <Input
                                            inputMode="url"
                                            placeholder="https://runtime.example.com"
                                            autoFocus={initialUrl === "" || changeServer}
                                            {...field}
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                    ) : (
                        <p className="text-xs text-muted-foreground">
                            Server: {hostOf(form.getValues("serverUrl"))} &middot;{" "}
                            <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setEditingUrl(true)}>
                                change
                            </Button>
                        </p>
                    )}
                    <FormField
                        control={form.control}
                        name="email"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Email</FormLabel>
                                <FormControl>
                                    <Input type="email" autoComplete="email" autoFocus={initialUrl !== "" && !changeServer} {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                </div>
                <RootError message={errors.root?.message} />
                <SubmitButton busy={isSubmitting}>Continue</SubmitButton>
            </form>
        </Form>
    );
}

function PasswordStep({ serverUrl, email, invitationToken, onDiscardInvitation }: { serverUrl: string; email: string; invitationToken?: string; onDiscardInvitation?: () => void }) {
    const { signIn } = useRuntime();
    const form = useForm<PasswordValues>({
        resolver: zodResolver(passwordSchema),
        defaultValues: { password: "" },
    });
    const { isSubmitting, errors } = form.formState;

    async function onSubmit(values: PasswordValues) {
        try {
            await signIn({ baseUrl: serverUrl, email, password: values.password, invitationToken });
        } catch (e) {
            form.setError("root", { message: messageOf(e) });
        }
    }

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
                <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Password</FormLabel>
                            <FormControl>
                                <PasswordInput autoComplete="current-password" autoFocus {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <RootError message={errors.root?.message} />
                {invitationToken && onDiscardInvitation && (
                    <Button type="button" variant="ghost" disabled={isSubmitting} onClick={onDiscardInvitation}>
                        Sign in without joining for now
                    </Button>
                )}
                <SubmitButton busy={isSubmitting}>Sign in</SubmitButton>
            </form>
        </Form>
    );
}

function InvitationRegistrationStep({
    serverUrl,
    onBack,
    onExistingAccount,
}: {
    serverUrl: string;
    onBack: (email: string, runtimeUrl: string) => void;
    onExistingAccount: (email: string, token: string, runtimeUrl: string) => void;
}) {
    const { signIn } = useRuntime();
    const form = useForm<InvitationRegistrationValues>({
        resolver: zodResolver(invitationRegistrationSchema),
        defaultValues: { serverUrl, token: "", email: "", name: "", password: "", confirm: "" },
    });
    const { isSubmitting, errors } = form.formState;
    const existing = errors.root?.type === "invitation_account_exists";

    async function onSubmit(values: InvitationRegistrationValues) {
        const baseUrl = normalizeBaseUrl(values.serverUrl);
        try {
            await new RuntimeClient(baseUrl).registerWithOrganizationInvitation({
                token: values.token.trim(),
                email: values.email.trim(),
                name: values.name.trim(),
                password: values.password,
            });
            form.setValue("token", "");
            form.setValue("password", "");
            form.setValue("confirm", "");
            try {
                await signIn({ baseUrl, email: values.email.trim(), password: values.password });
            } catch {
                form.setError("root", { message: "Your account was created and you joined the organization. Sign in to continue." });
            }
        } catch (error) {
            if (error instanceof RuntimeError && error.code === "invitation_account_exists") {
                form.setError("root", { type: error.code, message: error.message });
            } else {
                form.setError("root", { message: messageOf(error) });
            }
        }
    }

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">Use the email address on your invitation to create an account and join the organization.</p>
                <div className="flex flex-col gap-3">
                    <FormField control={form.control} name="serverUrl" render={({ field }) => (
                        <FormItem><FormLabel>Runtime URL</FormLabel><FormControl><Input inputMode="url" autoComplete="url" placeholder="https://runtime.example.com" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="token" render={({ field }) => (
                        <FormItem><FormLabel>Invitation token</FormLabel><FormControl><Input autoComplete="off" autoFocus {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="email" render={({ field }) => (
                        <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" autoComplete="email" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="name" render={({ field }) => (
                        <FormItem><FormLabel>Name</FormLabel><FormControl><Input autoComplete="name" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="password" render={({ field }) => (
                        <FormItem>
                            <FormLabel>Password</FormLabel><FormControl><PasswordInput autoComplete="new-password" {...field} /></FormControl>
                            {errors.password ? <FormMessage /> : <FormDescription>At least {MIN_PASSWORD} characters.</FormDescription>}
                        </FormItem>
                    )} />
                    <FormField control={form.control} name="confirm" render={({ field }) => (
                        <FormItem><FormLabel>Confirm password</FormLabel><FormControl><PasswordInput autoComplete="new-password" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                </div>
                <RootError message={errors.root?.message} />
                {existing && <Button type="button" variant="outline" disabled={isSubmitting} onClick={() => onExistingAccount(form.getValues("email"), form.getValues("token"), form.getValues("serverUrl"))}>Sign in and accept invitation</Button>}
                <SubmitButton busy={isSubmitting}>Create account and join</SubmitButton>
                <Button type="button" variant="ghost" disabled={isSubmitting} onClick={() => onBack(form.getValues("email"), form.getValues("serverUrl"))}>Back to sign in</Button>
            </form>
        </Form>
    );
}

function SetupStep({ serverUrl, email, onConflict }: { serverUrl: string; email: string; onConflict: () => void }) {
    const { setupAdmin } = useRuntime();
    const form = useForm<SetupValues>({
        resolver: zodResolver(setupSchema),
        defaultValues: { name: "", companyName: "", password: "", confirm: "" },
    });
    const { isSubmitting, errors } = form.formState;

    async function onSubmit(values: SetupValues) {
        try {
            await setupAdmin({
                baseUrl: serverUrl,
                email,
                password: values.password,
                name: values.name?.trim() || undefined,
                companyName: values.companyName?.trim() || undefined,
            });
        } catch (e) {
            if (e instanceof RuntimeError && e.status === 409) {
                toast.info("Setup is already complete", { description: "Sign in with your password." });
                onConflict();
                return;
            }
            form.setError("root", { message: messageOf(e) });
        }
    }

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
                <div className="flex flex-col gap-4">
                    <FormField
                        control={form.control}
                        name="name"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Name (optional)</FormLabel>
                                <FormControl>
                                    <Input autoComplete="name" autoFocus {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                    <FormField
                        control={form.control}
                        name="companyName"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Company name</FormLabel>
                                <FormControl>
                                    <Input autoComplete="organization" {...field} />
                                </FormControl>
                                <FormDescription>Optional. If blank, your first organization uses your name.</FormDescription>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                    <FormField
                        control={form.control}
                        name="password"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Password</FormLabel>
                                <FormControl>
                                    <PasswordInput autoComplete="new-password" {...field} />
                                </FormControl>
                                {errors.password ? (
                                    <FormMessage />
                                ) : (
                                    <FormDescription>At least {MIN_PASSWORD} characters.</FormDescription>
                                )}
                            </FormItem>
                        )}
                    />
                    <FormField
                        control={form.control}
                        name="confirm"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Confirm password</FormLabel>
                                <FormControl>
                                    <PasswordInput autoComplete="new-password" {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                </div>
                <RootError message={errors.root?.message} />
                <SubmitButton busy={isSubmitting}>Create administrator</SubmitButton>
            </form>
        </Form>
    );
}

/** Dedicated sign-in surface; account and invitation flows share the same form owner. */
export default function LoginScreen() {
    const [initialUrl] = useState(defaultBaseUrl);
    const [step, setStep] = useState<Step>("email");
    const [serverUrl, setServerUrl] = useState(initialUrl);
    const [email, setEmail] = useState("");
    const [pendingInvitationToken, setPendingInvitationToken] = useState<string | null>(null);

    const heading =
        step === "invite" ? "Join an organization" : step === "setup" ? "Set up your administrator" : step === "password" ? "Welcome back" : "Sign in to Floq";
    const subtitle =
        step === "invite"
            ? "Use the invitation token from your organization owner."
            : step === "setup"
            ? "This is the first run of this runtime. This email becomes the administrator account."
            : step === "password"
              ? "Enter your password to continue."
              : "Connect to your Floq Runtime to run agents in the cloud.";

    return (
        <section className="auth-screen" aria-label="Floq sign in">
            <div className="auth-layout">
                <div className="auth-story">
                    <div className="auth-wordmark"><span className="auth-logo"><IconBrandFloq size={28} /></span><span>Floq</span></div>
                    <h2>Your agents.<br />One workspace.</h2>
                    <p className="auth-story-description">Bring your projects, Claude Code, and Codex together.</p>
                    <FloqSurface className="auth-workflow rounded-[18px]" aria-label="How Floq works">
                        <div className="auth-workflow-row"><span className="auth-workflow-icon"><IconFolder size={19} /></span><div><strong>Bring your project</strong><span>Start with the code you call home.</span></div></div>
                        <div className="auth-workflow-row"><span className="auth-workflow-icon"><IconCode size={19} /></span><div><strong>Give your agents a direction</strong><span>Build with Claude Code and Codex.</span></div></div>
                        <div className="auth-workflow-row"><span className="auth-workflow-icon"><IconTerminal2 size={19} /></span><div><strong>Keep the work in view</strong><span>Follow every task, terminal, and change.</span></div></div>
                    </FloqSurface>
                    <div className="auth-providers"><span className="inline-flex items-center gap-2"><IconBrandClaude className="size-4" />Claude Code</span><span className="inline-flex items-center gap-2"><IconBrandCodex className="size-4" />Codex</span><span className="auth-provider-note">Your runtime. Your workspace.</span></div>
                </div>
                <FloqSurface className="auth-card rounded-[24px]">
                    <div className="auth-form-heading">
                        <span className="auth-form-symbol"><IconLock size={21} aria-hidden="true" /></span>
                        <h1 className="text-[1.65rem] font-semibold tracking-tight leading-tight">{heading}</h1>
                        <p className="text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
                        {step !== "email" && step !== "invite" && (
                            <div className="flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs">
                                <span className="max-w-56 truncate">{email}</span>
                                <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs text-muted-foreground" onClick={() => setStep("email")}>
                                    change
                                </Button>
                            </div>
                        )}
                    </div>

                    <div key={step} className="auth-form-content">
                        {step === "email" && (
                            <EmailStep
                                initialUrl={serverUrl}
                                initialEmail={email}
                                onDone={(values, next) => {
                                    setServerUrl(values.serverUrl);
                                    setEmail(values.email);
                                    if (pendingInvitationToken && values.email.trim().toLowerCase() !== email.trim().toLowerCase()) setPendingInvitationToken(null);
                                    setStep(next);
                                }}
                            />
                        )}
                        {step === "password" && <PasswordStep serverUrl={serverUrl} email={email} invitationToken={pendingInvitationToken ?? undefined} onDiscardInvitation={() => setPendingInvitationToken(null)} />}
                        {step === "setup" && (
                            <SetupStep serverUrl={serverUrl} email={email} onConflict={() => setStep("password")} />
                        )}
                        {step === "invite" && (
                            <InvitationRegistrationStep
                                serverUrl={serverUrl}
                                onBack={(invitedEmail, invitedRuntimeUrl) => {
                                    setServerUrl(invitedRuntimeUrl);
                                    setEmail(invitedEmail.trim());
                                    setPendingInvitationToken(null);
                                    setStep("email");
                                }}
                                onExistingAccount={(invitedEmail, token, invitedRuntimeUrl) => {
                                    setServerUrl(invitedRuntimeUrl);
                                    setEmail(invitedEmail.trim());
                                    setPendingInvitationToken(token.trim());
                                    setStep("email");
                                }}
                            />
                        )}
                    </div>

                    {step === "email" && (
                        <div className="auth-invitation">
                            <span>Invited to an organization?</span>
                            <Button type="button" variant="link" className="h-auto px-1" onClick={() => setStep("invite")}>
                                Join with an invitation
                            </Button>
                        </div>
                    )}

                    <div className="auth-card-footer"><IconServer size={14} aria-hidden="true" /><span>Connected through your Floq Runtime</span></div>
                </FloqSurface>
                <p className="auth-credit">Powered by <IconBrandFlowless size={14} /> Flowless</p>
            </div>
        </section>
    );
}
