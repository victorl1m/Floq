import { cn } from "cn";
import { organizationInitials } from "@/lib/organizations";

/** Rounded-square initials tile (decorative; the organization name is always rendered next to it). */
export function OrganizationAvatar({ name, className }: { name: string; className?: string }) {
    return (
        <span
            aria-hidden="true"
            className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-foreground ring-1 ring-foreground/10", className)}
        >
            {organizationInitials(name)}
        </span>
    );
}
