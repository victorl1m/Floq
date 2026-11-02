import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { RuntimeError, normalizeBaseUrl } from "@/lib/runtime/client";
import { Button } from "@/components/ui/button";
import IconBrandFloq from "@/components/ui/brand/IconBrandFloq";
import IconBrandFlowless from "@/components/ui/brand/IconBrandFlowless";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { Spinner } from "@/components/ui/spinner";
import { defaultBaseUrl, useRuntime } from "@/lib/runtime/store";
import {
    MIN_PASSWORD,
    emailSchema,
    passwordSchema,
    setupSchema,
    type EmailValues,
    type PasswordValues,
    type SetupValues,
} from "./schemas";

type Step = "email" | "password" | "setup";

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
        <Button type="submit" size="lg" className="w-full" disabled={busy || disabled}>
            {busy && <Spinner />}
            {children}
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
                            <button type="button" className="underline" onClick={() => setEditingUrl(true)}>
                                change
                            </button>
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

function PasswordStep({ serverUrl, email }: { serverUrl: string; email: string }) {
    const { signIn } = useRuntime();
    const form = useForm<PasswordValues>({
        resolver: zodResolver(passwordSchema),
        defaultValues: { password: "" },
    });
    const { isSubmitting, errors } = form.formState;

    async function onSubmit(values: PasswordValues) {
        try {
            await signIn({ baseUrl: serverUrl, email, password: values.password });
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
                                <Input type="password" autoComplete="current-password" autoFocus {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <RootError message={errors.root?.message} />
                <SubmitButton busy={isSubmitting}>Sign in</SubmitButton>
            </form>
        </Form>
    );
}

function SetupStep({ serverUrl, email, onConflict }: { serverUrl: string; email: string; onConflict: () => void }) {
    const { setupAdmin } = useRuntime();
    const form = useForm<SetupValues>({
        resolver: zodResolver(setupSchema),
        defaultValues: { name: "", password: "", confirm: "" },
    });
    const { isSubmitting, errors } = form.formState;

    async function onSubmit(values: SetupValues) {
        try {
            await setupAdmin({
                baseUrl: serverUrl,
                email,
                password: values.password,
                name: values.name?.trim() || undefined,
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
                        name="password"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Password</FormLabel>
                                <FormControl>
                                    <Input type="password" autoComplete="new-password" {...field} />
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
                                    <Input type="password" autoComplete="new-password" {...field} />
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

/** Required, unclosable sign-in dialog. */
export default function LoginScreen() {
    const [initialUrl] = useState(defaultBaseUrl);
    const [step, setStep] = useState<Step>("email");
    const [serverUrl, setServerUrl] = useState(initialUrl);
    const [email, setEmail] = useState("");

    const blockClose = (event: Event) => event.preventDefault();

    const heading =
        step === "setup" ? "Set up your administrator" : step === "password" ? "Welcome back" : "Sign in to Floq";
    const subtitle =
        step === "setup"
            ? "This is the first run of this runtime. This email becomes the administrator account."
            : step === "password"
              ? "Enter your password to continue."
              : "Connect to your Floq Runtime to run agents in the cloud.";

    return (
        <>
            <div
                aria-hidden
                className="fixed inset-x-0 top-[40px] bottom-0 z-[35] bg-background/80 backdrop-blur-sm bg-[radial-gradient(ellipse_at_top,var(--muted),transparent_65%)] before:absolute before:inset-0 before:bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] before:bg-[size:48px_48px] before:opacity-40 before:mask-[radial-gradient(ellipse_at_center,black,transparent_75%)]"
            />
            {/* Non-modal: Radix modal mode would disable pointer events on the titlebar and trap focus. */}
            <Dialog open modal={false}>
                <DialogContent
                    showCloseButton={false}
                    style={{ top: "calc(50% + 20px)" }}
                    onEscapeKeyDown={blockClose}
                    onPointerDownOutside={blockClose}
                    onInteractOutside={blockClose}
                    className="gap-6 p-8 sm:max-w-[400px]"
                >
                    <DialogHeader className="items-center gap-3 text-center">
                        <IconBrandFloq size={48} className="text-foreground" />
                        <DialogTitle className="text-xl font-semibold tracking-tight">{heading}</DialogTitle>
                        <DialogDescription>{subtitle}</DialogDescription>
                        {step !== "email" && (
                            <div className="flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs">
                                <span className="max-w-56 truncate">{email}</span>
                                <button type="button" className="text-muted-foreground underline" onClick={() => setStep("email")}>
                                    change
                                </button>
                            </div>
                        )}
                    </DialogHeader>

                    <div key={step} className="animate-in fade-in-0 slide-in-from-right-2 duration-200">
                        {step === "email" && (
                            <EmailStep
                                initialUrl={serverUrl}
                                initialEmail={email}
                                onDone={(values, next) => {
                                    setServerUrl(values.serverUrl);
                                    setEmail(values.email);
                                    setStep(next);
                                }}
                            />
                        )}
                        {step === "password" && <PasswordStep serverUrl={serverUrl} email={email} />}
                        {step === "setup" && (
                            <SetupStep serverUrl={serverUrl} email={email} onConflict={() => setStep("password")} />
                        )}
                    </div>

                    <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                        Powered by <IconBrandFlowless size={14} /> Flowless
                    </p>
                </DialogContent>
            </Dialog>
        </>
    );
}
