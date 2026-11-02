import { canReadClipboard, copyText, pasteShortcut, readClipboardText } from "@/lib/clipboard";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from "react";
import { IconCheck, IconClipboard, IconCopy, IconExternalLink } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import ClaudeOAuthDialog from "./claude-oauth-dialog";
import { AppDialog, CodeBox, ErrorBanner, Steps } from "@/components/ui/app-dialog";
import IconBrandClaude from "@/components/ui/brand/IconBrandClaude";
import IconBrandCodex from "@/components/ui/brand/IconBrandCodex";
import { cn } from "cn";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import SessionTerminal from "@/components/agents/session-terminal";
import { openExternal } from "@/lib/open-external";
import { RuntimeError } from "@/lib/runtime/client";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { LoginProviderId, SessionSummary } from "@/lib/runtime/types";

const NAME: Record<LoginProviderId, string> = { claude: "Claude", codex: "Codex" };

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>\x1b\x07]+/g;

interface Props {
    provider: LoginProviderId;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConnected?: () => void;
}

function TerminalConnectDialog({ provider, open: isOpen, onOpenChange, onConnected }: Props) {
    const { client } = useRuntime();
    const [session, setSession] = useState<SessionSummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [connected, setConnected] = useState(false);
    const [url, setUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const tail = useRef("");
    const sessionRef = useRef<SessionSummary | null>(null);
    sessionRef.current = session;
    const doneRef = useRef(false);
    const codeInput = useRef<HTMLInputElement>(null);
    const startRef = useRef<{ key: string; promise: Promise<SessionSummary> } | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [gotOutput, setGotOutput] = useState(false);
    const [slow, setSlow] = useState(false);
    const [stopped, setStopped] = useState(false);
    const [finishing, setFinishing] = useState(false);
    const [deviceCode, setDeviceCode] = useState<string | null>(null);
    const [expiresMin, setExpiresMin] = useState<number | null>(null);
    const [opened, setOpened] = useState(false);
    const [showDetails, setShowDetails] = useState(false);
    const isCodex = provider === "codex";
    const [finishFailed, setFinishFailed] = useState(false);
    const [promptSeen, setPromptSeen] = useState(false);
    const [loginFailed, setLoginFailed] = useState<string | null>(null);
    const [code, setCode] = useState("");
    const [sending, setSending] = useState(false);
    const [codeError, setCodeError] = useState<string | null>(null);

    // Start the hidden login session when the dialog opens.
    useEffect(() => {
        if (!isOpen || !client) return;
        let cancelled = false;
        doneRef.current = false;
        tail.current = "";
        setSession(null);
        setError(null);
        setConnected(false);
        setUrl(null);
        setGotOutput(false);
        setSlow(false);
        setStopped(false);
        setFinishing(false);
        setDeviceCode(null);
        setExpiresMin(null);
        setOpened(false);
        setFinishFailed(false);
        setPromptSeen(false);
        setLoginFailed(null);
        setCode("");
        setCodeError(null);
        // One login session per dialog open/attempt: StrictMode's mount, unmount, mount reuses the in-flight request.
        const key = provider + ":" + attempt;
        if (startRef.current?.key !== key) startRef.current = { key, promise: client.providerLogin(provider) };
        const started = startRef.current;
        started.promise
            .then((s) => {
                if (!cancelled) setSession(s);
            })
            .catch((e) => {
                if (startRef.current === started) startRef.current = null;
                if (cancelled) return;
                setError(
                    e instanceof RuntimeError && (e.status === 404 || e.status === 405)
                        ? "Your runtime doesn't support this yet."
                        : errorMessage(e),
                );
            });
        return () => {
            cancelled = true;
        };
    }, [isOpen, client, provider, attempt]);

    // No output: hint after 20s, treat as failed after 60s. Exited/failed session: stopped.
    useEffect(() => {
        if (!session || gotOutput || connected) return;
        const hint = setTimeout(() => setSlow(true), 20_000);
        const fail = setTimeout(() => setStopped(true), 60_000);
        return () => {
            clearTimeout(hint);
            clearTimeout(fail);
        };
    }, [session, gotOutput, connected]);

    useEffect(() => {
        if (!session || connected || finishing) return;
        // Exit code 0 means the CLI finished its login; credentials are imported a moment later.
        if (session.state === "exited" && session.exitCode === 0) setFinishing(true);
        else if (session.state === "exited" || session.state === "failed") setStopped(true);
    }, [session, connected, finishing]);

    // Signed in but not yet reported connected: give the runtime up to 20s to import the credentials.
    useEffect(() => {
        if (!finishing || connected) return;
        const timer = setTimeout(() => setFinishFailed(true), 20_000);
        return () => clearTimeout(timer);
    }, [finishing, connected]);

    // Poll the login status while open.
    useEffect(() => {
        if (!isOpen || !client || !session || stopped || finishFailed) return;
        const timer = setInterval(async () => {
            try {
                const status = await client.providersStatus();
                if (status[provider].connected && !doneRef.current) {
                    doneRef.current = true;
                    setConnected(true);
                    toast.success(NAME[provider] + " connected");
                    onConnected?.();
                    setTimeout(() => onOpenChange(false), 1200);
                }
            } catch {
                /* keep polling */
            }
        }, finishing ? 1000 : 2000);
        return () => clearInterval(timer);
    }, [isOpen, client, session, stopped, finishFailed, finishing, provider, onConnected, onOpenChange]);

    const onOutput = useCallback((data: string) => {
        setGotOutput(true);
        tail.current = (tail.current + data.replace(ANSI, "")).slice(-4000);
        if (/paste code/i.test(tail.current)) setPromptSeen(true);
        if (/invalid code/i.test(tail.current)) {
            setCodeError("That code wasn't accepted. Copy the whole code from the sign-in page and try again.");
            setSending(false);
        }
        if (/login successful|successfully logged in|logged in as/i.test(tail.current)) setFinishing(true);
        const failedLine = /login failed:?.*/i.exec(tail.current);
        if (failedLine) setLoginFailed(failedLine[0].trim());
        if (provider === "codex") {
            // Device flow: the one-time code appears after "Enter this one-time code".
            const at = tail.current.search(/one-time code/i);
            const scope = at >= 0 ? tail.current.slice(at) : tail.current;
            const codeMatch = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/.exec(scope);
            if (codeMatch) setDeviceCode(codeMatch[0]);
            const expiry = /expires in (\d+) minutes?/i.exec(tail.current);
            if (expiry) setExpiresMin(Number(expiry[1]));
        }
        const matches = tail.current.match(URL_PATTERN);
        if (matches) setUrl(matches[matches.length - 1]);
    }, [provider]);

    /** Deletes the login session this instance started (even if the request is still in flight). */
    function discardLogin() {
        const started = startRef.current;
        startRef.current = null;
        if (!started || doneRef.current || !client) return;
        void started.promise.then((s) => client.deleteSession(s.id)).catch(() => {});
    }

    function close(next: boolean) {
        if (next) return onOpenChange(true);
        // Closing before connecting cancels the login session.
        discardLogin();
        onOpenChange(false);
    }

    async function copyDeviceCode(silent = false) {
        if (!deviceCode) return;
        try {
            await copyText(deviceCode);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
            if (silent) toast.success("Code copied");
        } catch {
            toast.error("Could not copy the code");
        }
    }

    async function copy() {
        if (!url) return;
        try {
            await copyText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            toast.error("Could not copy the link");
        }
    }

    const BrandIcon = provider === "claude" ? IconBrandClaude : IconBrandCodex;
    const step = connected ? 4 : promptSeen ? 3 : url ? 2 : 1;
    const failed = error !== null || stopped || loginFailed !== null || finishFailed;
    const lastLines = tail.current
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-5)
        .join("\n");

    const cleanCode = (raw: string) =>
        [...raw]
            .filter((c) => c.trim() !== "")
            .join("")
            .replace(/^["']+|["']+$/g, "");

    async function pasteFromClipboard() {
        // Tauri reads the clipboard without a prompt; a browser relies on a normal paste event instead.
        if (!canReadClipboard()) {
            codeInput.current?.focus();
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

    function onPasteCode(event: ClipboardEvent<HTMLInputElement>) {
        const clean = cleanCode(event.clipboardData.getData("text"));
        if (clean.length >= 10) {
            event.preventDefault();
            setCode(clean);
            void submitCode(clean);
        }
    }

    async function submitCode(raw: string = code) {
        const current = sessionRef.current;
        if (!client || !current) return;
        // Strip all whitespace and surrounding quotes; send as plain input, not a bracketed paste.
        const clean = cleanCode(raw);
        if (!clean) return;
        setSending(true);
        setCodeError(null);
        tail.current = "";
        try {
            await client.sendInput(current.id, clean + String.fromCharCode(13));
            setCode("");
            // Stay "sending" until the CLI answers (invalid code message) or the status poll reports connected.
            setTimeout(() => setSending(false), 8000);
        } catch (e) {
            setSending(false);
            setCodeError(errorMessage(e));
        }
    }

    function retry() {
        discardLogin();
        setAttempt((n) => n + 1);
    }

    return (
        <AppDialog
            open={isOpen}
            onOpenChange={close}
            size="lg"
            icon={<BrandIcon />}
            title={"Connect " + NAME[provider]}
            description="Sign in with your subscription. No API key needed."
            footer={
                <Button variant="outline" onClick={() => close(false)}>
                    {connected ? "Close" : "Cancel"}
                </Button>
            }
            footerStart={
                connected || failed ? null : (
                    <span className="flex items-center gap-1.5">
                        <Spinner className="size-3" /> {finishing ? "Finishing sign-in..." : slow && !gotOutput ? "Still starting... this can take a moment on first use" : "Waiting for sign-in..."}
                    </span>
                )
            }
        >
            {failed ? (
                <div className="flex flex-col gap-3">
                    <ErrorBanner>{error ?? loginFailed ?? (finishFailed ? "Signed in, but the runtime didn't save the credentials. Try again." : "The sign-in terminal stopped.")}</ErrorBanner>
                    {!error && !loginFailed && !finishFailed && lastLines && (
                        <pre className="max-h-32 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{lastLines}</pre>
                    )}
                    <div>
                        <Button onClick={retry}>Try again</Button>
                    </div>
                </div>
            ) : connected ? (
                <p className="flex items-center gap-2 text-sm">
                    <IconCheck className="size-4 text-emerald-500" />
                    {NAME[provider]} is connected.
                </p>
            ) : (
                <>
                    {isCodex ? (
                        <Steps
                            steps={["Open the sign-in page", "Enter this code", "Approve"]}
                            current={finishing ? 3 : opened ? 2 : 1}
                        />
                    ) : (
                        <Steps steps={["Open the link", "Sign in", "Paste the code here if asked"]} current={step} />
                    )}
                    {isCodex && (
                        <div className="flex flex-col gap-4 rounded-xl border border-border bg-card/40 p-5">
                            {deviceCode ? (
                                <CodeBox code={deviceCode} copied={copied} onCopy={() => void copyDeviceCode()} />
                            ) : (
                                <Skeleton className="mx-auto h-12 w-64" />
                            )}
                            <div className="flex flex-col items-center gap-2">
                                <Button
                                    disabled={!url}
                                    onClick={() => {
                                        if (!url) return;
                                        setOpened(true);
                                        if (deviceCode) void copyDeviceCode(true);
                                        void openExternal(url).catch((e) => toast.error(errorMessage(e)));
                                    }}
                                >
                                    <IconExternalLink />
                                    Open sign-in page
                                </Button>
                                {expiresMin !== null && (
                                    <p className="text-xs text-muted-foreground">The code expires in {expiresMin} min.</p>
                                )}
                                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Spinner className="size-3" /> Waiting for you to approve in the browser...
                                </p>
                            </div>
                        </div>
                    )}
                    {!isCodex && url ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <Button onClick={() => void openExternal(url).catch((e) => toast.error(errorMessage(e)))}>
                                <IconExternalLink />
                                Open sign-in page
                            </Button>
                            <Button variant="outline" size="icon" aria-label="Copy link" onClick={() => void copy()}>
                                {copied ? <IconCheck /> : <IconCopy />}
                            </Button>
                        </div>
                    ) : null}
                    {!isCodex && (promptSeen || url) && (
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="auth-code">Authorization code</Label>
                            <div className="flex gap-2">
                                <Input
                                    id="auth-code"
                                    ref={codeInput}
                                    onPaste={onPasteCode}
                                    className="font-mono"
                                    autoComplete="off"
                                    spellCheck={false}
                                    placeholder="Paste the code from the sign-in page"
                                    value={code}
                                    aria-invalid={codeError !== null}
                                    onChange={(e) => {
                                        setCode(e.target.value);
                                        setCodeError(null);
                                    }}
                                    onKeyDown={(e) => e.key === "Enter" && void submitCode()}
                                />
                                <Button variant="outline" onClick={() => void pasteFromClipboard()}>
                                    <IconClipboard />
                                    Paste
                                </Button>
                                <Button disabled={sending || !code.trim()} onClick={() => void submitCode()}>
                                    {sending && <Spinner />}
                                    Submit code
                                </Button>
                            </div>
                            {codeError && <p className="text-xs text-destructive">{codeError}</p>}
                        </div>
                    )}
                    {isCodex && (
                        <button
                            type="button"
                            className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
                            onClick={() => setShowDetails((v) => !v)}
                        >
                            {showDetails ? "Hide details" : "Show details"}
                        </button>
                    )}
                    <div className={cn("overflow-hidden rounded-xl border border-border", isCodex && !showDetails && "hidden")}>
                        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                            <span className={cn("size-2 rounded-full", session ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                            Terminal &middot; {provider} login
                        </div>
                        <div className="relative h-64">
                            {session ? (
                                <SessionTerminal
                                    sessionId={session.id}
                                    active
                                    embedded={{ session, onSession: setSession }}
                                    onOutput={onOutput}
                                />
                            ) : (
                                <div className="flex h-full items-center justify-center">
                                    <Spinner />
                                </div>
                            )}
                        </div>
                    </div>
                </>
            )}
        </AppDialog>
    );
}

/** Claude uses the server-side OAuth flow; Codex (and older runtimes) use the terminal flow. */
export default function ConnectProviderDialog(props: Props) {
    const [fallback, setFallback] = useState(false);
    const unsupported = useCallback(() => setFallback(true), []);
    if (props.provider === "claude" && !fallback) {
        return <ClaudeOAuthDialog {...props} onUnsupported={unsupported} />;
    }
    return <TerminalConnectDialog {...props} />;
}
