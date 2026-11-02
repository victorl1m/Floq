import { useEffect, useState } from "react";
import { IconExternalLink } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CodeBox, Steps } from "@/components/ui/app-dialog";
import { Spinner } from "@/components/ui/spinner";
import { copyText } from "@/lib/clipboard";
import { openExternal } from "@/lib/open-external";
import { errorMessage, useClient } from "@/lib/runtime/store";
import type { DeviceFlow } from "@/lib/runtime/types";

/** GitHub device flow: start, then poll until connected / denied / expired. */
export function useGithubDeviceFlow(onConnected: () => void | Promise<void>) {
    const client = useClient();
    const [flow, setFlow] = useState<DeviceFlow | null>(null);
    const [starting, setStarting] = useState(false);

    useEffect(() => {
        if (!flow) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = (seconds: number) => {
            timer = setTimeout(async () => {
                try {
                    const result = await client.githubPoll(flow.flowId);
                    if (cancelled) return;
                    if (result.status === "pending") return poll(result.interval);
                    setFlow(null);
                    if (result.status === "connected") {
                        toast.success("GitHub connected as " + result.login);
                        await onConnected();
                    } else {
                        toast.error(result.status === "denied" ? "GitHub authorization was denied" : "The code expired, try again");
                    }
                } catch (e) {
                    if (cancelled) return;
                    setFlow(null);
                    toast.error("GitHub connection failed", { description: errorMessage(e) });
                }
            }, Math.max(1, seconds) * 1000);
        };
        poll(flow.interval);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [flow, client, onConnected]);

    async function start() {
        setStarting(true);
        try {
            setFlow(await client.githubStart());
        } catch (e) {
            toast.error("Could not start GitHub connection", { description: errorMessage(e) });
        } finally {
            setStarting(false);
        }
    }

    return { flow, starting, start, cancel: () => setFlow(null) };
}

export function GithubFlowPanel({ flow, onCancel }: { flow: DeviceFlow; onCancel: () => void }) {
    const [copied, setCopied] = useState(false);

    async function copy() {
        try {
            await copyText(flow.userCode);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            toast.error("Could not copy the code");
        }
    }

    return (
        <div className="flex flex-col gap-5 rounded-xl border border-border bg-card/40 p-5">
            <Steps steps={["Open GitHub's device page", "Enter the code below", "Approve Floq"]} current={2} />
            <CodeBox code={flow.userCode} copied={copied} onCopy={() => void copy()} />
            <div className="flex flex-col items-center gap-3">
                <Button onClick={() => void openExternal(flow.verificationUri).catch((e) => toast.error(errorMessage(e)))}>
                    <IconExternalLink />
                    Open {flow.verificationUri}
                </Button>
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Spinner /> Waiting for authorization...
                </p>
                <Button variant="ghost" size="sm" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}
