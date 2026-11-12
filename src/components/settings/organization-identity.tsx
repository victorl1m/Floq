import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { IconCheck, IconPhoto, IconTrash, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OrganizationAvatar } from "@/components/organization/organization-avatar";
import { isValidSlug, NAME_MAX, organizationLabel, SLUG_MAX } from "@/lib/organizations";
import { firstImageFile, ORG_IMAGE_ACCEPT, prepareOrganizationImage } from "@/lib/org-image";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import type { Organization } from "@/lib/runtime/types";
import { SavedCheck, SettingRow, SettingsGroup, useSavedFlash } from "./ui";

type SlugState = "idle" | "unchanged" | "checking" | "available" | "taken" | "invalid" | "reserved" | "unknown";

const SLUG_MESSAGE: Record<SlugState, string> = {
    idle: "Lowercase letters, numbers and single hyphens, 3-40 characters.",
    unchanged: "This is the current URL name.",
    checking: "Checking availability…",
    available: "Available",
    taken: "Already taken. Try another.",
    invalid: "Use 3-40 lowercase letters, numbers or single hyphens (not at the ends).",
    reserved: "That name is reserved. Try another.",
    unknown: "Could not check availability. It will be checked when you save.",
};

/** Name, image and URL name of the active organization. Owners and admins edit; members see it read-only. */
export function OrganizationIdentity({ org }: { org: Organization }) {
    const client = useClient();
    const { refreshOrganizations } = useRuntime();
    const ids = { name: useId(), slug: useId(), slugStatus: useId() };
    const canEdit = org.role === "owner" || org.role === "admin";
    const isPersonal = org.personal === true;

    const [name, setName] = useState(org.name);
    const [nameSaved, flashName] = useSavedFlash();
    useEffect(() => setName(org.name), [org.id, org.name]);

    async function saveName() {
        const next = name.trim().replace(/\s+/g, " ");
        if (!next || next === org.name) { setName(org.name); return; }
        try {
            await client.updateOrganization(org.id, { name: next });
            await refreshOrganizations(org.id);
            flashName();
        } catch (error) {
            toast.error("Could not rename the organization", { description: errorMessage(error) });
            setName(org.name);
        }
    }

    // --- image ---
    const fileRef = useRef<HTMLInputElement>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [imageBusy, setImageBusy] = useState(false);
    const [dragging, setDragging] = useState(false);
    useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
    useEffect(() => setPreview(null), [org.id]);

    async function applyImage(file: File | null) {
        if (!file || !canEdit || imageBusy) return;
        setImageBusy(true);
        try {
            const prepared = await prepareOrganizationImage(file);
            setPreview(URL.createObjectURL(prepared));
            await client.setOrganizationImage(org.id, prepared);
            await refreshOrganizations(org.id);
            toast.success("Image updated");
        } catch (error) {
            toast.error("Could not update the image", { description: errorMessage(error) });
        } finally {
            setPreview(null);
            setImageBusy(false);
        }
    }

    async function removeImage() {
        if (!canEdit || imageBusy) return;
        setImageBusy(true);
        try {
            await client.removeOrganizationImage(org.id);
            await refreshOrganizations(org.id);
        } catch (error) {
            toast.error("Could not remove the image", { description: errorMessage(error) });
        } finally {
            setImageBusy(false);
        }
    }

    const onDrop = (event: DragEvent) => { event.preventDefault(); setDragging(false); void applyImage(firstImageFile(event.dataTransfer.files)); };
    const onPaste = (event: ClipboardEvent) => { const file = firstImageFile(event.clipboardData.files); if (file) { event.preventDefault(); void applyImage(file); } };

    // --- URL name ---
    const [slug, setSlug] = useState(org.slug);
    const [slugState, setSlugState] = useState<SlugState>("unchanged");
    const [slugBusy, setSlugBusy] = useState(false);
    const [slugError, setSlugError] = useState<string | null>(null);
    const [slugSaved, flashSlug] = useSavedFlash();
    useEffect(() => { setSlug(org.slug); setSlugError(null); }, [org.id, org.slug]);

    useEffect(() => {
        if (isPersonal) return;
        if (slug === org.slug) { setSlugState("unchanged"); return; }
        if (!slug) { setSlugState("idle"); return; }
        if (!isValidSlug(slug)) { setSlugState("invalid"); return; }
        setSlugState("checking");
        let current = true;
        const timer = setTimeout(() => {
            client.organizationSlugAvailable(slug, org.id)
                .then((result) => { if (current) setSlugState(result.available ? "available" : (result.reason ?? "taken")); })
                .catch(() => { if (current) setSlugState("unknown"); });
        }, 300);
        return () => { current = false; clearTimeout(timer); };
    }, [slug, org.slug, org.id, client, isPersonal]);

    const canSaveSlug = canEdit && !slugBusy && (slugState === "available" || slugState === "unknown");

    async function saveSlug() {
        if (!canSaveSlug) return;
        setSlugBusy(true);
        setSlugError(null);
        try {
            await client.updateOrganization(org.id, { slug });
            await refreshOrganizations(org.id);
            flashSlug();
        } catch (error) {
            const code = (error as { code?: string } | null)?.code;
            if (code === "slug_taken") setSlugState("taken");
            else if (code === "reserved_slug") setSlugState("reserved");
            else setSlugError(errorMessage(error));
        } finally {
            setSlugBusy(false);
        }
    }

    const slugBad = slugState === "taken" || slugState === "invalid" || slugState === "reserved";
    const host = (() => { try { return new URL(client.baseUrl).host; } catch { return "floq"; } })();

    return (
        <SettingsGroup title="Identity">
            <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center" onPaste={onPaste}>
                <div
                    data-testid="org-image-drop"
                    data-dragging={dragging}
                    onDragOver={(event) => { if (canEdit) { event.preventDefault(); setDragging(true); } }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={onDrop}
                    className="flex items-center gap-4 rounded-xl data-[dragging=true]:ring-2 data-[dragging=true]:ring-primary"
                >
                    <OrganizationAvatar name={organizationLabel(org)} imageUrl={org.imageUrl} preview={preview} className="size-16 rounded-2xl text-lg" />
                    <div className="flex min-w-0 flex-col gap-1">
                        <p className="truncate text-sm font-semibold">{organizationLabel(org)}</p>
                        <p className="text-xs text-muted-foreground">{canEdit ? "Choose, drop or paste an image. It is cropped to a square." : "Only owners and admins can change the image."}</p>
                    </div>
                </div>
                {canEdit && (
                    <div className="flex items-center gap-2 sm:ml-auto">
                        <input ref={fileRef} type="file" accept={ORG_IMAGE_ACCEPT} className="sr-only" aria-label="Organization image file" data-testid="org-image-input" tabIndex={-1}
                            onChange={(event) => { const file = event.target.files?.[0] ?? null; event.target.value = ""; void applyImage(file); }} />
                        <Button variant="outline" loading={imageBusy} onClick={() => fileRef.current?.click()}><IconPhoto aria-hidden="true" />{org.imageUrl ? "Change image" : "Upload image"}</Button>
                        {org.imageUrl && <Button variant="ghost" disabled={imageBusy} onClick={() => void removeImage()}><IconTrash aria-hidden="true" />Remove</Button>}
                    </div>
                )}
            </div>
            <SettingRow label="Name" description={canEdit ? "Shown across the app." : "Only owners and admins can rename the organization."} htmlFor={ids.name}>
                <SavedCheck show={nameSaved} />
                <Input
                    id={ids.name}
                    className="w-56"
                    maxLength={NAME_MAX}
                    value={name}
                    disabled={!canEdit}
                    onChange={(event) => setName(event.target.value)}
                    onBlur={() => void saveName()}
                    onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                />
            </SettingRow>
            {isPersonal ? (
                <SettingRow label="URL name" description="Your personal organization has no URL name. Only team organizations get one." />
            ) : (
                <SettingRow label="URL name" description={canEdit ? "Where this organization lives. Pick something short; it must be unique." : "Only owners and admins can change the URL name."} htmlFor={ids.slug} stack>
                    <div className="flex w-full flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                            <Input
                                id={ids.slug}
                                className="max-w-xs font-mono"
                                value={slug}
                                maxLength={SLUG_MAX}
                                spellCheck={false}
                                autoCapitalize="none"
                                disabled={!canEdit}
                                aria-invalid={slugBad || undefined}
                                aria-describedby={ids.slugStatus}
                                onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/\s+/g, "-"))}
                                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveSlug(); } }}
                            />
                            {canEdit && <Button loading={slugBusy} disabled={!canSaveSlug} onClick={() => void saveSlug()}>Save</Button>}
                            <SavedCheck show={slugSaved} />
                        </div>
                        <p id={ids.slugStatus} role="status" aria-live="polite" data-state={slugState} data-testid="slug-status" className={slugBad ? "flex items-center gap-1 text-xs text-destructive" : "flex items-center gap-1 text-xs text-muted-foreground"}>
                            {slugState === "available" && <IconCheck aria-hidden="true" className="size-3.5 text-emerald-600 dark:text-emerald-400" />}
                            {slugBad && <IconX aria-hidden="true" className="size-3.5" />}
                            <span>{canEdit ? SLUG_MESSAGE[slugState] : ""}</span>
                        </p>
                        {slug && <p className="text-xs text-muted-foreground" data-testid="slug-preview">URL: <span className="font-mono">{host}/{slug}</span></p>}
                        {slugError && <p role="alert" className="text-xs text-destructive">{slugError}</p>}
                    </div>
                </SettingRow>
            )}
        </SettingsGroup>
    );
}
