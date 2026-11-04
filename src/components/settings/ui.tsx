import { useEffect, useState, type ReactNode } from "react";
import { IconCheck } from "@tabler/icons-react";
import { cn } from "cn";

export function SettingsPage({ title, description, children }: { title: string; description: string; children: ReactNode }) {
    return (
        <div className="settings-page flex flex-col gap-7">
            <div className="flex flex-col gap-1">
                <h1 className="page-heading font-semibold tracking-tight">{title}</h1>
                <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{description}</p>
            </div>
            {children}
        </div>
    );
}

/** A rounded, bordered card holding rows separated by dividers. */
export function SettingsGroup({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
    return (
        <section className="flex flex-col gap-2">
            {title && <h2 className="px-1 text-sm font-medium text-muted-foreground">{title}</h2>}
            <div className={cn("settings-group material-content divide-y divide-border rounded-2xl", className)}>{children}</div>
        </section>
    );
}

export function SettingRow({
    label,
    description,
    htmlFor,
    children,
    stack = false,
}: {
    label: ReactNode;
    description?: ReactNode;
    htmlFor?: string;
    children?: ReactNode;
    /** Put the control under the label (wide controls such as forms). */
    stack?: boolean;
}) {
    return (
        <div className={cn("flex gap-4 p-4", stack ? "flex-col" : "flex-col sm:flex-row sm:items-center sm:justify-between")}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <label htmlFor={htmlFor} className="text-sm font-medium">
                    {label}
                </label>
                {description && <div className="max-w-prose text-xs leading-relaxed text-muted-foreground">{description}</div>}
            </div>
            {children && <div className={cn("flex shrink-0 items-center gap-2", stack && "w-full")}>{children}</div>}
        </div>
    );
}

/** Small "Saved" confirmation that fades after a moment. */
export function SavedCheck({ show }: { show: boolean }) {
    return (
        <span
            role="status"
            className={cn(
                "flex min-w-12 items-center gap-1 text-xs text-muted-foreground transition-opacity duration-150",
                show ? "opacity-100" : "opacity-0",
            )}
        >
            {show && <><IconCheck aria-hidden="true" className="size-3" />Saved</>}
        </span>
    );
}

/** Returns [flag, trigger]: flag is true for ~1.5s after trigger() is called. */
export function useSavedFlash(): [boolean, () => void] {
    const [saved, setSaved] = useState(false);
    useEffect(() => {
        if (!saved) return;
        const timer = setTimeout(() => setSaved(false), 1500);
        return () => clearTimeout(timer);
    }, [saved]);
    return [saved, () => setSaved(true)];
}
