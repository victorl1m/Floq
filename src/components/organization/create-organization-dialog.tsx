import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { IconBuilding, IconCheck, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { AppDialog, ErrorBanner } from "@/components/ui/app-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import { isValidSlug, NAME_MAX, SLUG_MAX, slugify } from "@/lib/organizations";

type SlugState = "idle" | "invalid" | "checking" | "available" | "taken" | "reserved" | "unknown";

export function CreateOrganizationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const client = useClient();
    const { refreshOrganizations } = useRuntime();
    const ids = { name: useId(), slug: useId(), slugStatus: useId() };
    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    const [slugEdited, setSlugEdited] = useState(false);
    const [slugState, setSlugState] = useState<SlugState>("idle");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const nameRef = useRef<HTMLInputElement>(null);

    // The account menu that opened this dialog restores focus to its trigger as it closes; take focus back afterwards.
    useEffect(() => {
        if (!open) return;
        const timer = setTimeout(() => nameRef.current?.focus(), 150);
        return () => clearTimeout(timer);
    }, [open]);

    useEffect(() => {
        if (open) return;
        setName(""); setSlug(""); setSlugEdited(false); setSlugState("idle"); setError(null); setBusy(false);
    }, [open]);

    // The slug follows the name until the person edits it by hand.
    useEffect(() => { if (!slugEdited) setSlug(slugify(name)); }, [name, slugEdited]);

    useEffect(() => {
        if (!slug) { setSlugState("idle"); return; }
        if (!isValidSlug(slug)) { setSlugState("invalid"); return; }
        setSlugState("checking");
        let current = true;
        const timer = setTimeout(() => {
            client.organizationSlugAvailable(slug)
                .then((result) => { if (current) setSlugState(result.available ? "available" : result.reason === "reserved" ? "reserved" : result.reason === "invalid" ? "invalid" : "taken"); })
                .catch(() => { if (current) setSlugState("unknown"); });
        }, 300);
        return () => { current = false; clearTimeout(timer); };
    }, [slug, client]);

    const canSubmit = name.trim().length > 0 && slug.length > 0 && (slugState === "available" || slugState === "unknown") && !busy;

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            const organization = await client.createOrganization(name.trim(), slug);
            await refreshOrganizations(organization.id);
            toast.success(`Created ${organization.name}`, { description: "It is now your active organization." });
            onOpenChange(false);
        } catch (reason) {
            setError(errorMessage(reason));
            if (reason instanceof Error && /taken/i.test(reason.message)) setSlugState("taken");
        } finally {
            setBusy(false);
        }
    }

    const slugMessage: Record<SlugState, string> = {
        idle: "Letters, numbers and hyphens. Filled in from the name.",
        invalid: "Use 3-40 lowercase letters, numbers or single hyphens (not at the ends).",
        checking: "Checking availability…",
        available: "Available",
        taken: "Already taken. Try another.",
        reserved: "That name is reserved. Try another.",
        unknown: "Could not check availability. It will be checked when you create.",
    };

    return (
        <AppDialog
            open={open}
            onOpenChange={(next) => !busy && onOpenChange(next)}
            icon={<IconBuilding aria-hidden="true" />}
            title="Create organization"
            description="An organization belongs to your account, so it follows you to every device. Invite people once it exists."
            size="sm"
            footer={
                <>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
                    <Button type="submit" form="create-organization-form" loading={busy} disabled={!canSubmit} shimmer>Create organization</Button>
                </>
            }
        >
            <form id="create-organization-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
                <div className="flex flex-col gap-1.5">
                    <label htmlFor={ids.name} className="text-sm font-medium">Name</label>
                    <Input ref={nameRef} id={ids.name} value={name} maxLength={NAME_MAX} autoFocus placeholder="Acme Studio" onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                    <label htmlFor={ids.slug} className="text-sm font-medium">URL name</label>
                    <Input
                        id={ids.slug}
                        value={slug}
                        maxLength={SLUG_MAX}
                        spellCheck={false}
                        autoCapitalize="none"
                        aria-invalid={slugState === "invalid" || slugState === "taken" || undefined}
                        aria-describedby={ids.slugStatus}
                        onChange={(e) => { setSlugEdited(true); setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-")); }}
                    />
                    <p id={ids.slugStatus} role="status" aria-live="polite" className={slugState === "taken" || slugState === "invalid" || slugState === "reserved" ? "flex items-center gap-1 text-xs text-destructive" : "flex items-center gap-1 text-xs text-muted-foreground"}>
                        {slugState === "available" && <IconCheck aria-hidden="true" className="size-3.5 text-emerald-600 dark:text-emerald-400" />}
                        {(slugState === "taken" || slugState === "invalid" || slugState === "reserved") && <IconX aria-hidden="true" className="size-3.5" />}
                        <span>{slugMessage[slugState]}</span>
                    </p>
                    {slug && isValidSlug(slug) && <p className="text-xs text-muted-foreground">Preview: <span className="font-mono">{slug}</span></p>}
                </div>
                <div aria-live="assertive">{error && <ErrorBanner>{error}</ErrorBanner>}</div>
            </form>
        </AppDialog>
    );
}
