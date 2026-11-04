import { UsageMeters } from "@/components/window/usage-meter";
import { MemoryUsageButton } from "@/components/window/memory-usage";
import { ApprovalChip } from "@/components/window/approval-requests";
import { ForwardedPorts } from "@/components/window/forwarded-ports";

export default function Footer() {
    return (
        <footer
            data-slot="app-footer"
            className="glass-surface fixed inset-x-0 bottom-0 z-30 flex h-(--app-footer-height) items-center justify-between border-t border-border px-4 text-[11px] text-muted-foreground select-none"
        >
            <UsageMeters />
            <div className="flex min-w-0 items-center">
                <MemoryUsageButton />
                <ApprovalChip />
                <ForwardedPorts />
            </div>
        </footer>
    );
}
