import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { IconCheck, IconClipboard, IconCopy, IconExternalLink } from "@tabler/icons-react";
import { toast } from "sonner";
import { AppDialog, ErrorBanner, Steps } from "@/components/ui/app-dialog";
import IconBrandClaude from "@/components/ui/brand/IconBrandClaude";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { canReadClipboard, copyText, pasteShortcut, readClipboardText } from "@/lib/clipboard";
import { openExternal } from "@/lib/open-external";
import { RuntimeError } from "@/lib/runtime/client";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { ClaudeOAuthStart } from "@/lib/runtime/types";

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConnected?: () => void;
    /** The runtime has no oauth/start endpoint: use the terminal flow instead. */
    onUnsupported: () => void;
}

/** The code is "<code>#<state>": strip whitespace and surrounding quotes but keep the '#'. */
const cleanCode = (raw: string) =>
    [...raw]
        .filter((c) => c.trim() !== "")
        .join("")
        .replace(/^["']+|["']+$/g, "");

const isMissing = (e: unknown) => e instanceof RuntimeError && (e.status === 404 || e.status === 405) && e.code !== "flow_expired";
const isExpired = (e: unknown) =>
    e instanceof RuntimeError && (e.status === 410 || /expired|flow_not_found|unknown_flow/i.test(e.code + " " + e.message));

export default function ClaudeOAuthDialog({ open: isOpen, onOpenChange, onConnected, onUnsupported }: Props) {
    const { client } = useRuntime();
    const [flow, setFlow] = useState<ClaudeOAuthStart | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [opened, setOpened] = useState(false);
    const [copied, setCopied] = useState(false);
    const [code, setCode] = useState("");
    const [codeError, setCodeError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [plan, setPlan] = useState<string | null | undefined>(undefined);
    const [connected, setConnected] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [cooldown, setCooldown] = useState(0);
    const startRef = useRef<{ key: number; promise: Promise<ClaudeOAuthStart> } | null>(null);
    const input = useRef<HTMLInputElement>(null);

    // Rate-limit countdown (seconds) shown on the Submit button.
    useEffect(() => {
        if (cooldown <= 0) return;
        const timer = setTimeout(() => setCooldown((n) => n - 1), 1000);
        return () => clearTimeout(timer);
    }, [cooldown]);

    // Start one flow per open/attempt (StrictMode's remount reuses the in-flight request).
    useEffect(() => {
        if (!isOpen || !client) return;
        let cancelled = false;
        setFlow(null);
        setError(null);
        if (startRef.current?.key !== attempt) startRef.current = { key: attempt, promise: client.claudeOAuthStart() };
        const started = startRef.current;
        started.promise
            .then((f) => {
                if (!cancelled) setFlow(f);
            })
            .catch((e) => {
                if (startRef.current === started) startRef.current = null;
                if (cancelled) return;
                if (isMissing(e)) onUnsupported();
                else setError(errorMessage(e));
            });
        return () => {
            cancelled = true;
        };
    }, [isOpen, client, attempt, onUnsupported]);

    function close(next: boolean) {
        if (next) return onOpenChange(true);
        startRef.current = null;
        onOpenChange(false);
    }

    async function copyLink() {
        if (!flow) return;
        try {
            await copyText(flow.authorizeUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            toast.error("Could not copy the link");
        }
    }

    async function pasteFromClipboard() {
        if (!canReadClipboard()) {
            input.current?.focus();
            toast.info("Press " + pasteShortcut() + " to paste the code");
            return;
        }
        try {
            setCode((await readClipboardText()) ?? "");
            setCodeError(null);
        } catch {
            toast.error("Could not read the clipboard", { description: "Paste with " + pasteShortcut() + " instead." });
        }
    }

    async function submit(raw: string = code) {
        const clean = cleanCode(raw);
        if (!client || !flow || !clean || sending || cooldown > 0) return;
        setSending(true);
        setCodeError(null);
        setNotice(null);
        try {
            const result = await client.claudeOAuthFinish(flow.flowId, clean);
            if (!result.connected) throw new Error("Claude did not connect. Try again.");
            setPlan(result.plan);
            setConnected(true);
            toast.success("Claude connected");
            onConnected?.();
            setTimeout(() => close(false), 1000);
        } catch (e) {
            if (isExpired(e)) {
                // The flow timed out on the server: start a fresh one automatically.
                setNotice("Sign-in link refreshed. Open it again.");
                setOpened(false);
                setCode("");
                setAttempt((n) => n + 1);
            } else if (e instanceof RuntimeError && (e.status === 429 || e.code === "rate_limited")) {
                setCodeError(e.message);
                setCooldown(30);
            } else if (e instanceof RuntimeError && e.status === 502) {
                setCodeError("Couldn't reach Anthropic, try again.");
            } else if (e instanceof RuntimeError && (e.code === "invalid_code" || e.status === 400)) {
                setCodeError("That code wasn't accepted. Copy the whole code from the sign-in page and try again.");
            } else {
                setCodeError(errorMessage(e));
            }
        } finally {
            setSending(false);
        }
    }

    function onPasteCode(event: ClipboardEvent<HTMLInputElement>) {
        const clean = cleanCode(event.clipboardData.getData("text"));
        if (clean.length >= 10) {
            event.preventDefault();
            setCode(clean);
            void submit(clean);
        }
    }

    return (
        <AppDialog
            open={isOpen}
            onOpenChange={close}
            size="md"
            icon={<IconBrandClaude />}
            title="Connect Claude"
            description="Sign in with your Claude subscription. No API key needed."
            footer={
                <Button variant="outline" onClick={() => close(false)}>
                    {connected ? "Close" : "Cancel"}
                </Button>
            }
        >
            {error ? (
                <div className="flex flex-col gap-3">
                    <ErrorBanner>{error}</ErrorBanner>
                    <div>
                        <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
                    </div>
                </div>
            ) : connected ? (
                <p className="flex items-center gap-2 text-sm">
                    <IconCheck className="size-4 text-emerald-500" />
                    Connected{plan ? " · " + plan : ""}
                </p>
            ) : (
                <>
                    <Steps steps={["Open the sign-in page", "Sign in and approve", "Paste the code"]} current={opened ? 3 : 1} />
                    {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
                    {flow ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                onClick={() => {
                                    setOpened(true);
                                    void openExternal(flow.authorizeUrl).catch((e) => toast.error(errorMessage(e)));
                                    setTimeout(() => input.current?.focus(), 100);
                                }}
                            >
                                <IconExternalLink />
                                Open sign-in page
                            </Button>
                            <Button variant="outline" size="icon" aria-label="Copy link" onClick={() => void copyLink()}>
                                {copied ? <IconCheck /> : <IconCopy />}
                            </Button>
                        </div>
                    ) : (
                        <Skeleton className="h-8 w-44" />
                    )}
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="claude-code">Authorization code</Label>
                        <div className="flex gap-2">
                            <Input
                                id="claude-code"
                                ref={input}
                                className="font-mono"
                                autoComplete="off"
                                spellCheck={false}
                                disabled={!flow}
                                placeholder="Paste the code from the sign-in page"
                                value={code}
                                aria-invalid={codeError !== null}
                                onChange={(e) => {
                                    setCode(e.target.value);
                                    setCodeError(null);
                                }}
                                onPaste={onPasteCode}
                                onKeyDown={(e) => e.key === "Enter" && void submit()}
                            />
                            <Button variant="outline" disabled={!flow} onClick={() => void pasteFromClipboard()}>
                                <IconClipboard />
                                Paste
                            </Button>
                            <Button disabled={!flow || sending || cooldown > 0 || !code.trim()} onClick={() => void submit()}>
                                {sending && <Spinner />}
                                {cooldown > 0 ? `Retry in ${cooldown}s` : "Submit code"}
                            </Button>
                        </div>
                        {codeError && <p className="text-xs text-destructive">{codeError}</p>}
                    </div>
                </>
            )}
        </AppDialog>
    );
}
