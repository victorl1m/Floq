import { UsageMeters } from "@/components/window/usage-meter";
import { MemoryUsageButton } from "@/components/window/memory-usage";

export default function Footer() {
    return (
        <footer
            data-slot="app-footer"
            className="fixed inset-x-0 bottom-0 z-30 flex h-(--app-footer-height) items-center justify-between border-t border-border bg-background px-4 text-[11px] text-muted-foreground select-none"
        >
            <UsageMeters />
            <MemoryUsageButton />
        </footer>
    );
}
