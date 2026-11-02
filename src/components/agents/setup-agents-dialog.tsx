import { useState } from "react";
import { IconCheck, IconRobot } from "@tabler/icons-react";
import { AppDialog, StatusPill } from "@/components/ui/app-dialog";
import { Button } from "@/components/ui/button";
import IconBrandClaude from "@/components/ui/brand/IconBrandClaude";
import IconBrandCodex from "@/components/ui/brand/IconBrandCodex";
import { Skeleton } from "@/components/ui/skeleton";
import ConnectProviderDialog from "@/components/settings/connect-provider-dialog";
import { useProviderStatus } from "@/components/settings/use-provider-status";
import type { LoginProviderId } from "@/lib/runtime/types";
import { cn } from "cn";

const CARDS: { id: LoginProviderId; name: string; subtitle: string; Icon: typeof IconBrandClaude }[] = [
    { id: "claude", name: "Claude", subtitle: "Claude Pro / Max subscription", Icon: IconBrandClaude },
    { id: "codex", name: "Codex", subtitle: "ChatGPT subscription", Icon: IconBrandCodex },
];

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The provider the user picked; "Continue" unlocks once it is connected. */
    preferred: LoginProviderId;
    onContinue: () => void;
    /** Called after a provider finishes connecting. */
    onStatusChange?: () => void;
}

/** Lists both subscriptions; lets the user connect either before sending. */
export default function SetupAgentsDialog({ open, onOpenChange, preferred, onContinue, onStatusChange }: Props) {
    const { status, unsupported, reload } = useProviderStatus();
    const [connecting, setConnecting] = useState<LoginProviderId | null>(null);
    const ready = status?.[preferred].connected === true;

    return (
        <>
            <AppDialog
                open={open}
                onOpenChange={onOpenChange}
                icon={<IconRobot />}
                title="Set up your agents"
                description="Agents sign in with your own subscriptions. Connect the one you want to use."
                footer={
                    <>
                        <Button variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            disabled={!ready}
                            onClick={() => {
                                onOpenChange(false);
                                onContinue();
                            }}
                        >
                            Continue
                        </Button>
                    </>
                }
            >
                {unsupported && <p className="text-sm text-muted-foreground">Your runtime doesn't support this yet.</p>}
                <div className="flex flex-col gap-3">
                    {CARDS.map(({ id, name, subtitle, Icon }) => {
                        const connected = status?.[id].connected ?? false;
                        return (
                            <div
                                key={id}
                                className={cn(
                                    "flex items-center gap-3 rounded-xl border p-4 transition-colors",
                                    id === preferred ? "border-border bg-muted/60" : "border-border hover:bg-muted/40"
                                )}
                            >
                                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                                    <Icon size={22} />
                                </div>
                                <div className="flex min-w-0 flex-1 flex-col gap-1">
                                    <span className="text-sm font-medium">{name}</span>
                                    <span className="text-xs text-muted-foreground">{subtitle}</span>
                                </div>
                                {status ? (
                                    <StatusPill ok={connected}>{connected ? "Connected" + (status[id].plan ? " · " + status[id].plan : "") : "Not connected"}</StatusPill>
                                ) : (
                                    <Skeleton className="h-5 w-24 rounded-full" />
                                )}
                                {connected ? (
                                    <IconCheck className="size-4 text-emerald-500" />
                                ) : (
                                    <Button size="sm" disabled={!status || unsupported} onClick={() => setConnecting(id)}>
                                        Connect
                                    </Button>
                                )}
                            </div>
                        );
                    })}
                </div>
            </AppDialog>
            {connecting && (
                <ConnectProviderDialog
                    provider={connecting}
                    open
                    onOpenChange={(next) => !next && setConnecting(null)}
                    onConnected={() => {
                        void reload();
                        onStatusChange?.();
                    }}
                />
            )}
        </>
    );
}
