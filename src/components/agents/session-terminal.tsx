import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { IconPlayerPlay, IconSearch, IconChevronUp, IconChevronDown, IconX, IconGitCompare, IconUpload } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { createPortal } from "react-dom";
import { cn } from "cn";
import { useTitlebarSlot } from "@/lib/titlebar-slot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { canReadClipboard, copyText, readClipboardImagePng, readClipboardText } from "@/lib/clipboard";
import { parseOsc52 } from "@/lib/osc52";
import { HeldInput } from "@/lib/held-input";
import { MAX_UPLOAD_COUNT, browserUploadItems, shellQuote, tauriDropItems, uploadBatch, type UploadItem } from "./upload-toast";

const MAX_INPUT_CHARS = 20_000;

export const STATE_DOT: Record<SessionState, string> = {
    running: "bg-emerald-500",
    starting: "bg-amber-400 animate-pulse",
    sleeping: "bg-muted-foreground/40",
    exited: "bg-muted-foreground/40",
    failed: "bg-destructive",
};
import { openExternal } from "@/lib/open-external";
import { MONO_FONT_FAMILY, loadMonoFont } from "@/lib/fonts";
import { effectiveScrollback, loadPerformancePrefs, loadTerminalPrefs, usePerformancePrefs, useTerminalPrefs } from "@/lib/prefs";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { ClientFrame, ServerFrame, SessionState, SessionSummary } from "@/lib/runtime/types";
import { ProviderIcon, isLive } from "./provider";
import { resumeHint, sleepReasonText } from "./sleep-copy";
import { formatDistanceToNowStrict } from "date-fns";
import { openRightSidebar } from "@/lib/right-sidebar";
import { minimumContrastRatio, terminalTheme, useTerminalDark } from "@/lib/terminal-theme";

interface Props {
    sessionId: string;
    active: boolean;
    /** Keep titlebar actions on the focused split pane only. Defaults on for normal tabs. */
    titlebarActions?: boolean;
    /** Hide the session identity when its owning tab/pane already displays it. */
    titlebarTitle?: boolean;
    /** Split siblings stay visible without repeatedly stealing keyboard focus. */
    focusOnActive?: boolean;
    /** For hidden sessions that are not in the store (e.g. provider login): no toolbar or overlay. */
    embedded?: { session: SessionSummary; onSession: (session: SessionSummary) => void };
    /** Use an alpha terminal background when displayed over the expanded glass dialog. */
    transparentBackground?: boolean;
    /** Called with every chunk of terminal output. */
    onOutput?: (data: string) => void;
}

/** One xterm instance + stream socket per session. Stays mounted while the session is open. */
/** The replay is hidden and normally finishes instantly; only a slow one gets a label. */
function DelayedReloadLabel() {
    const [show, setShow] = useState(false);
    useEffect(() => {
        const timer = setTimeout(() => setShow(true), 600);
        return () => clearTimeout(timer);
    }, []);
    if (!show) return null;
    return <div role="status" className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center text-xs text-muted-foreground">Reloading…</div>;
}

export default function SessionTerminal({ sessionId, active, titlebarActions = true, titlebarTitle = true, focusOnActive = true, embedded, onOutput, transparentBackground = false }: Props) {
    const { client, sessions, upsertSession, resumeRequest, consumeResumeRequest } = useRuntime();
    const session = embedded?.session ?? sessions.find((s) => s.id === sessionId);
    const live = session ? isLive(session.state) : false;
    const canReplayTerminal = session?.state === "failed" || session?.state === "exited";

    const hostRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const wsRef = useRef<WebSocket | null>(null);
    // Keystrokes typed while the stream reconnects; sent, in order, as soon as it is open again.
    const heldInputRef = useRef(new HeldInput());
    const holdInput = (data: string) => {
        const held = heldInputRef.current;
        const first = held.size === 0;
        if (held.hold(data) && first) {
            toast.warning("Reconnecting to the terminal", {
                id: "terminal-held-input",
                description: "What you type is kept and sent when the connection is back, for up to 2 minutes. Clicks are not kept.",
            });
        } else if (held.dropped > 0) {
            toast.error("Some typing was not kept", {
                id: "terminal-held-input",
                description: "The terminal has been disconnected too long or too much was typed. Retype it once the terminal is back.",
            });
        }
    };
    const flushHeldInput = (ws: WebSocket) => {
        const held = heldInputRef.current;
        const dropped = held.dropped;
        const data = held.take();
        held.clear();
        if (!data) return;
        for (let i = 0; i < data.length; i += MAX_INPUT_CHARS) ws.send(JSON.stringify({ type: "input", data: data.slice(i, i + MAX_INPUT_CHARS) } satisfies ClientFrame));
        toast.success("Reconnected", {
            id: "terminal-held-input",
            description: dropped > 0 ? `Sent what you typed. ${dropped} older characters were not kept.` : "Sent what you typed while the terminal was reconnecting.",
        });
    };
    const lastSeqRef = useRef(0);
    // True while replayed (buffered) output is being parsed; OSC 52 clipboard writes are ignored then.
    const replayingRef = useRef(false);
    const replayUntilRef = useRef(0);
    const runRef = useRef<string | null>(null);
    const upsertRef = useRef(upsertSession);
    upsertRef.current = embedded ? embedded.onSession : upsertSession;
    const outputRef = useRef(onOutput);
    outputRef.current = onOutput;
    const activeRef = useRef(active);
    activeRef.current = active;
    const providerRef = useRef(session?.provider);
    providerRef.current = session?.provider;
    const sessionIdRef = useRef(sessionId);
    sessionIdRef.current = sessionId;
    const uploadFilesRef = useRef<(files: UploadItem[]) => void>(() => undefined);
    const uploadingRef = useRef(false);
    const canUploadRef = useRef(false);

    const slot = useTitlebarSlot();
    const dark = useTerminalDark();
    const themeRef = useRef({ dark, transparentBackground });
    themeRef.current = { dark, transparentBackground };
    const [termPrefs] = useTerminalPrefs();
    const [performancePrefs] = usePerformancePrefs();
    const [termReady, setTermReady] = useState(false);
    // True while buffered output is replayed after the terminal was released and mounted again.
    const [reloading, setReloading] = useState(false);
    const [busy, setBusy] = useState<"resume" | null>(null);
    const [resumeError, setResumeError] = useState<string | null>(null);
    const resumingRef = useRef(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchText, setSearchText] = useState("");
    const [searchMessage, setSearchMessage] = useState("");
    const [uploading, setUploading] = useState(false);
    const [dropHover, setDropHover] = useState(false);
    canUploadRef.current = Boolean(!embedded && live && termReady && busy === null && active);

    async function uploadFiles(files: UploadItem[]) {
        if (!client || !files.length || !canUploadRef.current || uploadingRef.current) return;
        uploadingRef.current = true;
        setUploading(true);
        const picked = files.slice(0, MAX_UPLOAD_COUNT);
        if (files.length > MAX_UPLOAD_COUNT) toast.error(`Only the first ${MAX_UPLOAD_COUNT} files will be uploaded`, { description: "Upload the rest in a separate batch." });
        const originalTerm = termRef.current;
        const originalSocket = wsRef.current;
        const originalSessionId = sessionId;
        try {
            // One toast per batch shows progress, speed and ETA, and can cancel (deleting the partial file).
            const { paths } = await uploadBatch(client, originalSessionId, picked);
            const uploadedPaths = paths.map(shellQuote);
            const socket = wsRef.current;
            const canPaste = uploadedPaths.length && canUploadRef.current && originalTerm && termRef.current === originalTerm && sessionIdRef.current === originalSessionId && originalSocket && socket === originalSocket && socket.readyState === WebSocket.OPEN;
            if (canPaste) {
                originalTerm.paste(uploadedPaths.join(" ") + " ");
                originalTerm.focus();
            } else if (uploadedPaths.length) {
                toast.error("Files uploaded, but the terminal disconnected", {
                    description: "Copy the saved paths and paste them after reconnecting.",
                    action: { label: "Copy paths", onClick: () => void copyText(uploadedPaths.join(" ") + " ").catch(() => toast.error("Could not copy the paths", { description: "The clipboard is blocked. The files are already uploaded, so do not upload them again." })) },
                });
            }
        } finally {
            uploadingRef.current = false;
            setUploading(false);
        }
    }
    uploadFilesRef.current = (files) => { void uploadFiles(files); };

    useEffect(() => {
        if (embedded || !isTauri()) return;
        let unlisten: (() => void) | undefined;
        let disposed = false;
        void getCurrentWindow().onDragDropEvent((event) => {
            if (event.payload.type === "leave") { setDropHover(false); return; }
            if (!canUploadRef.current) { setDropHover(false); return; }
            const host = hostRef.current;
            if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
            const rect = host.getBoundingClientRect();
            const x = event.payload.position.x / window.devicePixelRatio;
            const y = event.payload.position.y / window.devicePixelRatio;
            const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
            if (event.payload.type === "enter" || event.payload.type === "over") {
                setDropHover(inside);
                return;
            }
            setDropHover(false);
            if (event.payload.type !== "drop" || !inside) return;
            // Files are streamed from disk by the Tauri side; only name and size are read here.
            void tauriDropItems(event.payload.paths).then((items) => uploadFilesRef.current(items));
        }).then((off) => { if (disposed) off(); else unlisten = off; }).catch(() => undefined);
        return () => { disposed = true; unlisten?.(); };
    }, [embedded]);

    function openSearch() {
        setSearchOpen(true);
        setSearchMessage("");
    }

    function closeSearch() {
        setSearchOpen(false);
        setSearchText("");
        setSearchMessage("");
        searchAddonRef.current?.clearDecorations();
        termRef.current?.focus();
    }

    function findInTerminal(direction: "next" | "previous", text = searchText, incremental = false) {
        const query = text;
        if (!query) {
            searchAddonRef.current?.clearDecorations();
            setSearchMessage("");
            return;
        }
        const found = direction === "next"
            ? searchAddonRef.current?.findNext(query, incremental ? { incremental: true } : undefined)
            : searchAddonRef.current?.findPrevious(query);
        setSearchMessage(found ? "" : "No matches");
    }

    useEffect(() => {
        if (!searchOpen) return;
        const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, [searchOpen]);

    useEffect(() => {
        const onShortcut = (event: KeyboardEvent) => {
            const target = event.target;
            const terminalFocused = target instanceof Node && hostRef.current?.contains(target);
            const xtermInput = target instanceof HTMLElement && target.classList.contains("xterm-helper-textarea");
            const typing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
            if (!activeRef.current || !terminalFocused || (typing && !xtermInput) || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "f") return;
            event.preventDefault();
            openSearch();
        };
        window.addEventListener("keydown", onShortcut);
        return () => window.removeEventListener("keydown", onShortcut);
    }, [active]);

    // Terminal lifecycle: created once, kept for the lifetime of the open tab.
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        let disposed = false;
        let cleanup: (() => void) | undefined;

        // xterm measures glyphs on open, so wait for the mono font first.
        void loadMonoFont().then(() => {
            if (disposed) return;
            cleanup = setup(host);
            setTermReady(true);
        });

        return () => {
            disposed = true;
            cleanup?.();
            setTermReady(false);
        };

        function setup(host: HTMLDivElement) {
        const term = new Terminal({
            fontFamily: MONO_FONT_FAMILY,
            fontSize: loadTerminalPrefs().fontSize,
            cursorStyle: loadTerminalPrefs().cursorStyle,
            cursorBlink: loadTerminalPrefs().cursorBlink,
            scrollback: effectiveScrollback(loadPerformancePrefs()),
            smoothScrollDuration: 0,
            allowProposedApi: true,
            allowTransparency: transparentBackground,
            minimumContrastRatio: minimumContrastRatio(themeRef.current.dark),
            theme: terminalTheme(themeRef.current.dark, transparentBackground),
            // Clicking a link opens it directly (no native confirm dialog).
            linkHandler: { activate: (_event, uri) => void openExternal(uri), allowNonHttpProtocols: false },
        });
        const fit = new FitAddon();
        const search = new SearchAddon();
        term.loadAddon(fit);
        term.loadAddon(search);
        term.loadAddon(new WebLinksAddon((_event, uri) => void openExternal(uri)));
        term.open(host);
        termRef.current = term;
        fitRef.current = fit;
        searchAddonRef.current = search;

        const send = (frame: ClientFrame) => {
            const ws = wsRef.current;
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                // Reconnecting (runtime restart, network blip): hold keystrokes instead of dropping them.
                if (frame.type === "input") holdInput(frame.data);
                return;
            }
            // Keep each frame well under the server's 256 KB cap (UTF-8 can be 3 bytes per char).
            if (frame.type === "input" && frame.data.length > MAX_INPUT_CHARS) {
                for (let i = 0; i < frame.data.length; i += MAX_INPUT_CHARS) {
                    ws.send(JSON.stringify({ type: "input", data: frame.data.slice(i, i + MAX_INPUT_CHARS) }));
                }
                return;
            }
            ws.send(JSON.stringify(frame));
        };

        // Clipboard: Tauri reads/writes without a prompt. In a browser a read would prompt, so paste keys
        // are left alone and the native paste event reaches xterm's textarea.
        const isMac = /Mac|iPhone|iPad/i.test(navigator.platform);
        // Claude Code and Codex read images from the clipboard of the machine they run on, which is the
        // runtime host, not this one. So an image on the local clipboard is uploaded and its path pasted.
        const imagePasteProvider = () => providerRef.current === "claude" || providerRef.current === "codex";
        const uploadClipboardImage = (bytes: Uint8Array) => {
            uploadFilesRef.current([{ name: `pasted-image-${Date.now()}.png`, size: bytes.byteLength, blob: new Blob([bytes as BlobPart], { type: "image/png" }) }]);
        };
        const pasteFromClipboard = async () => {
            try {
                const text = await readClipboardText();
                if (text) { term.paste(text); return; }
            } catch {
                // An image-only clipboard can make the text read fail; fall through to the image read.
            }
            if (!imagePasteProvider()) return;
            const png = await readClipboardImagePng();
            if (png) uploadClipboardImage(png);
        };
        // Browser: the native paste event decides. Image file and no text => upload; otherwise xterm pastes text.
        const onPasteCapture = (event: ClipboardEvent) => {
            if (!imagePasteProvider()) return;
            const clip = event.clipboardData;
            if (!clip || clip.getData("text/plain")) return;
            const item = Array.from(clip.items ?? []).find((entry) => entry.kind === "file" && entry.type.startsWith("image/"));
            const file = item?.getAsFile();
            if (!file) return;
            event.preventDefault();
            event.stopPropagation();
            void file.arrayBuffer().then((buffer) => {
                const extension = file.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
                uploadFilesRef.current([{ name: `pasted-image-${Date.now()}.${extension}`, size: buffer.byteLength, blob: new Blob([buffer], { type: file.type }) }]);
            });
        };
        host.addEventListener("paste", onPasteCapture, true);
        const copySelection = async (text: string): Promise<boolean> => {
            try {
                await copyText(text);
                return true;
            } catch (e) {
                toast.error("Could not copy to the clipboard", { id: "terminal-copy", description: errorMessage(e) });
                return false;
            }
        };
        // Copy on select: wait for the mouse button to be released (a user gesture, and one write per
        // drag) instead of copying on every selection change. The selection stays highlighted.
        let mouseDown = false;
        let pendingSelectionCopy = false;
        const onMouseDown = () => {
            mouseDown = true;
        };
        const onMouseUp = () => {
            mouseDown = false;
            if (!pendingSelectionCopy) return;
            pendingSelectionCopy = false;
            const selection = term.getSelection();
            if (selection) void copySelection(selection);
        };
        host.addEventListener("mousedown", onMouseDown);
        document.addEventListener("mouseup", onMouseUp);
        const selectionChange = term.onSelectionChange(() => {
            if (!term.hasSelection()) return;
            if (mouseDown) pendingSelectionCopy = true;
            else {
                const selection = term.getSelection();
                if (selection) void copySelection(selection);
            }
        });
        term.attachCustomKeyEventHandler((event) => {
            if (event.type !== "keydown") return true;
            const key = event.key.toLowerCase();
            if (!embedded && activeRef.current && key === "f" && (event.ctrlKey || event.metaKey) && !event.altKey) {
                event.preventDefault();
                openSearch();
                return false;
            }
            const mod = isMac ? event.metaKey : event.ctrlKey;
            if (!mod || event.altKey) return true;
            if (key === "v") {
                if (!canReadClipboard()) return true;
                event.preventDefault();
                void pasteFromClipboard();
                return false;
            }
            if (key === "c") {
                const selection = term.getSelection();
                if (isMac || event.shiftKey || selection) {
                    if (selection) {
                        event.preventDefault();
                        // Clear after a plain Ctrl+C so the next one interrupts.
                        void copySelection(selection).then((ok) => {
                            if (ok && !isMac && !event.shiftKey) term.clearSelection();
                        });
                    }
                    return false;
                }
                return true; // Ctrl+C without a selection is ^C for the PTY
            }
            return true;
        });
        // OSC 52: TUIs with mouse reporting (Claude Code) select text themselves and send it as
        // ESC ] 52 ; c ; <base64> ST. Only live output may write the clipboard: replayed scrollback is
        // old, so `replaying` is true while it is parsed. Read queries (`?`) are never answered.
        const osc52 = term.parser.registerOscHandler(52, (payload) => {
            if (replayingRef.current) return true;
            const text = parseOsc52(payload);
            if (text) void copySelection(text);
            return true;
        });
        const onContextMenu = (event: MouseEvent) => {
            const selection = term.getSelection();
            if (selection) {
                event.preventDefault();
                void copySelection(selection);
            } else if (canReadClipboard()) {
                event.preventDefault();
                void pasteFromClipboard();
            }
        };
        host.addEventListener("contextmenu", onContextMenu);
        const doFit = () => {
            // Hidden tabs (display: none) have no size; fitting would collapse the terminal.
            if (host.clientWidth === 0 || host.clientHeight === 0) return;
            try {
                const dims = fit.proposeDimensions();
                if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
                // Same cell grid: nothing to do (avoids needless reflow/SIGWINCH redraws that shift the viewport).
                if (dims.cols === term.cols && dims.rows === term.rows) return;
                const buffer = term.buffer.active;
                const wasAtBottom = buffer.viewportY >= buffer.baseY;
                const previousY = buffer.viewportY;
                fit.fit();
                // Keep the bottom pinned if the user was there; otherwise keep their scroll position.
                if (wasAtBottom) term.scrollToBottom();
                else term.scrollToLine(Math.min(previousY, term.buffer.active.baseY));
            } catch {
                /* not laid out yet */
            }
        };
        // Debounced so dragging the right panel's resize handle refits once the size settles.
        let refitTimer: ReturnType<typeof setTimeout> | undefined;
        const refit = () => {
            clearTimeout(refitTimer);
            refitTimer = setTimeout(doFit, 80);
        };

        const data = term.onData((d) => send({ type: "input", data: d }));
        const resize = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
        const observer = new ResizeObserver(refit);
        observer.observe(host);
        doFit();

        return () => {
            clearTimeout(refitTimer);
            observer.disconnect();
            host.removeEventListener("paste", onPasteCapture, true);
            host.removeEventListener("contextmenu", onContextMenu);
            host.removeEventListener("mousedown", onMouseDown);
            document.removeEventListener("mouseup", onMouseUp);
            selectionChange.dispose();
            osc52.dispose();
            data.dispose();
            resize.dispose();
            term.dispose();
            termRef.current = null;
            fitRef.current = null;
            searchAddonRef.current = null;
        };
        }
    }, []);

    // Apply appearance changes live.
    useEffect(() => {
        const term = termRef.current;
        if (!term) return;
        term.options.fontSize = termPrefs.fontSize;
        term.options.cursorStyle = termPrefs.cursorStyle;
        term.options.cursorBlink = termPrefs.cursorBlink;
        term.options.scrollback = effectiveScrollback(performancePrefs);
        term.options.smoothScrollDuration = performancePrefs.smoothTerminalScrolling && !performancePrefs.reduceMotion ? 100 : 0;
        try {
            fitRef.current?.fit();
        } catch {
            /* hidden */
        }
    }, [termPrefs, performancePrefs, termReady]);

    // Stream connection: only while the session is live; reconnects with backoff from the last seq.
    useEffect(() => {
        // Keep the xterm instance mounted for scrollback, but only read the PTY while visible.
        // Hidden tabs reconnect from lastSeqRef when activated, avoiding duplicate streams beside canvas mirrors.
        if (!client || !active || (!live && !canReplayTerminal) || !termReady) return;
        let stopped = false;
        let attempt = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let reloadTimer: ReturnType<typeof setTimeout> | undefined;

        const connect = () => {
            const term = termRef.current;
            if (stopped || !term) return;
            const ws = new WebSocket(client.streamUrl(sessionId, lastSeqRef.current));
            wsRef.current = ws;

            ws.onopen = () => {
                attempt = 0;
                ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows } satisfies ClientFrame));
                flushHeldInput(ws);
            };
            ws.onmessage = (event) => {
                let frame: ServerFrame;
                try {
                    frame = JSON.parse(String(event.data)) as ServerFrame;
                } catch {
                    return;
                }
                switch (frame.type) {
                    case "hello": {
                        const run = String(frame.session.startedAt);
                        const restarted =
                            (runRef.current !== null && runRef.current !== run) || lastSeqRef.current > frame.session.seq;
                        runRef.current = run;
                        // Every output frame with seq <= hello.session.seq is buffered replay; the server
                        // builds hello and the replay in one tick, so later frames are live.
                        replayUntilRef.current = frame.session.seq;
                        replayingRef.current = true;
                        if (lastSeqRef.current < frame.session.seq) {
                            setReloading(true);

                            clearTimeout(reloadTimer);
                            reloadTimer = setTimeout(() => { term.scrollToBottom(); setReloading(false); }, 4_000);
                        }
                        upsertRef.current(frame.session);
                        if (restarted) {
                            // A resumed session starts a new PTY with seq back at 0: start over.
                            term.reset();
                            lastSeqRef.current = 0;
                            ws.close();
                        }
                        break;
                    }
                    case "output":
                        if (frame.seq > lastSeqRef.current) {
                            lastSeqRef.current = frame.seq;
                            if (frame.seq >= replayUntilRef.current) {
                                clearTimeout(reloadTimer);
                                term.write("", () => { term.scrollToBottom(); setReloading(false); });
                            }
                            if (replayingRef.current && frame.seq > replayUntilRef.current) {
                                // First live frame: xterm parses writes in order, so this empty write's
                                // callback runs once all replay is parsed and before this frame is.
                                term.write("", () => {
                                    replayingRef.current = false;
                                });
                            }
                            term.write(frame.data);
                            outputRef.current?.(frame.data);
                        }
                        break;
                    case "state":
                    case "exit":
                        upsertRef.current(frame.session);
                        break;
                    case "error":
                        term.write(`\r\n\x1b[31m[floq] ${frame.message}\x1b[0m\r\n`);
                        break;
                    default:
                        break;
                }
            };
            ws.onclose = () => {
                if (wsRef.current === ws) wsRef.current = null;
                if (stopped || !live) return;
                const delay = Math.min(10_000, 300 * 2 ** attempt++);
                timer = setTimeout(connect, delay);
            };
        };
        connect();

        return () => {
            stopped = true;
            clearTimeout(timer);
            clearTimeout(reloadTimer);
            const ws = wsRef.current;
            wsRef.current = null;
            ws?.close();
        };
    }, [client, active, live, canReplayTerminal, sessionId, termReady]);

    // Live theme switch: swap colours on the open terminal (scrollback and stream untouched, no remount).
    useEffect(() => {
        const term = termRef.current;
        if (!term) return;
        term.options.minimumContrastRatio = minimumContrastRatio(dark);
        term.options.theme = terminalTheme(dark, transparentBackground);
        term.refresh(0, term.rows - 1);
    }, [dark, transparentBackground, termReady]);

    // Refit and focus when the tab becomes visible.
    useEffect(() => {
        if (!active) return;
        const frame = requestAnimationFrame(() => {
            const host = hostRef.current;
            if (host && host.clientWidth > 0) {
                try {
                    fitRef.current?.fit();
                } catch {
                    /* ignore */
                }
                if (focusOnActive) termRef.current?.focus();
            }
        });
        return () => cancelAnimationFrame(frame);
    }, [active]);

    async function resume() {
        if (!client || resumingRef.current) return;
        resumingRef.current = true;
        setResumeError(null);
        setBusy("resume");
        try {
            upsertSession(await client.resumeSession(sessionId));
        } catch (e) {
            setResumeError(errorMessage(e));
        } finally {
            resumingRef.current = false;
            setBusy(null);
        }
    }

    // A deliberate click on this (sleeping) session asked for an immediate resume. The request is
    // one-shot: consumed here whatever happens, so a failure leaves the asleep screen and Resume button.
    useEffect(() => {
        if (!resumeRequest || resumeRequest.id !== sessionId || embedded) return;
        consumeResumeRequest(resumeRequest.seq);
        if (session?.state === "sleeping") void resume();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resumeRequest]);

    if (!session) return null;

    const stoppedAgo = session.endedAt && !Number.isNaN(Date.parse(session.endedAt))
        ? formatDistanceToNowStrict(new Date(session.endedAt), { addSuffix: true })
        : null;
    const overlayTitle =
        session.state === "failed" ? "This agent failed" : session.state === "exited" ? "This agent exited" : "This agent is asleep";

    return (
        <div className={cn("absolute inset-0 flex-col", active ? "flex" : "hidden")}>
            {!embedded && titlebarActions && active && session.provider !== "shell" && slot &&
                createPortal(
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                        {titlebarTitle && <>
                            <ProviderIcon provider={session.provider} />
                            <span className="truncate text-sm font-medium">{session.title}</span>
                            <span
                                title={session.state}
                                aria-label={session.state}
                                className={cn("size-2 shrink-0 rounded-full", STATE_DOT[session.state])}
                            />
                        </>}
                        <div className="ml-auto flex shrink-0 items-center">
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label="Review project changes"
                                        onClick={() => openRightSidebar("changes")}
                                    >
                                        <IconGitCompare />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>Review project changes</TooltipContent>
                            </Tooltip>
                        </div>
                    </div>,
                    slot,
                )}
            <div
                className={cn("relative min-h-0 flex-1", !transparentBackground && "terminal-surface")}
                onDragEnter={(event) => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); if (canUploadRef.current) setDropHover(true); } }}
                onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; if (canUploadRef.current) setDropHover(true); } }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropHover(false); }}
                onDrop={(event) => {
                    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
                    event.preventDefault();
                    setDropHover(false);
                    browserUploadItems(Array.from(event.dataTransfer.files), (items) => uploadFilesRef.current(items));
                }}
            >
                <div ref={hostRef} className={cn("absolute inset-2", reloading && "invisible")} />
                {reloading && <DelayedReloadLabel />}
                {dropHover && <div aria-hidden="true" className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-md border border-dashed border-primary bg-primary/10 text-sm font-medium text-primary-text">Drop files to upload</div>}
                {!embedded && active && <>
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="sr-only"
                        tabIndex={-1}
                        aria-label="Choose files to upload to terminal"
                        onChange={(event) => {
                            const files = Array.from(event.currentTarget.files ?? []);
                            event.currentTarget.value = "";
                            browserUploadItems(files, (items) => uploadFilesRef.current(items));
                        }}
                    />
                    <div className="absolute top-2 right-11 z-10 flex items-center gap-1">
                        {uploading && <span role="status" aria-live="polite" className="flex items-center gap-1.5 rounded-md border border-border bg-popover/90 px-2 py-1 text-xs text-popover-foreground"><Spinner className="size-3" />Uploading</span>}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon-sm" aria-label="Upload files to terminal" disabled={!canUploadRef.current || uploadingRef.current} onClick={() => fileInputRef.current?.click()}>
                                    <IconUpload />
                                </Button>
                            </TooltipTrigger>
                                <TooltipContent>Upload files (up to 8 GiB each, 50 files)</TooltipContent>
                        </Tooltip>
                    </div>
                </>}
                {!embedded && active && !searchOpen && (
                    <div className="absolute top-2 right-2 z-10">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon-sm" aria-label="Search terminal output" onClick={openSearch}>
                                    <IconSearch />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Search terminal output (Ctrl+F)</TooltipContent>
                        </Tooltip>
                    </div>
                )}
                {!embedded && active && searchOpen && (
                    <div role="search" aria-label="Terminal scrollback search" className="absolute top-2 right-2 z-20 flex w-[min(28rem,calc(100%-1rem))] items-center gap-1 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg">
                        <Input
                            ref={searchInputRef}
                            value={searchText}
                            onChange={(event) => {
                                setSearchText(event.target.value);
                                findInTerminal("next", event.target.value, true);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    findInTerminal(event.shiftKey ? "previous" : "next");
                                } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    closeSearch();
                                }
                            }}
                            aria-label="Search terminal output"
                            placeholder="Find in terminal…"
                            className="h-7 min-w-0 flex-1 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
                        />
                        <span aria-live="polite" className="min-w-0 truncate px-1 text-xs text-muted-foreground">{searchMessage}</span>
                        {searchText && (
                            <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label="Clear terminal search"
                                onClick={() => {
                                    setSearchText("");
                                    setSearchMessage("");
                                    searchAddonRef.current?.clearDecorations();
                                    searchInputRef.current?.focus();
                                }}
                            >
                                <IconX />
                            </Button>
                        )}
                        <Button variant="ghost" size="icon-xs" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!searchText} onClick={() => findInTerminal("previous")}>
                            <IconChevronUp />
                        </Button>
                        <Button variant="ghost" size="icon-xs" aria-label="Next match" title="Next match (Enter)" disabled={!searchText} onClick={() => findInTerminal("next")}>
                            <IconChevronDown />
                        </Button>
                        <Button variant="ghost" size="icon-xs" aria-label="Close terminal search" onClick={closeSearch}>
                            <IconX />
                        </Button>
                    </div>
                )}
                {!live && !embedded && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center terminal-scrim p-4 text-center">
                        <div className="flex max-h-full w-full max-w-sm flex-col items-center gap-3 overflow-y-auto py-2">
                            <div className="flex max-w-full items-center gap-2 text-muted-foreground">
                                <ProviderIcon provider={session.provider} />
                                <span className="truncate text-xs">{session.title}</span>
                            </div>
                            <p className="text-sm font-medium text-foreground">{overlayTitle}</p>
                            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                                {session.state === "failed" ? (
                                    <p className="text-foreground/80">
                                        {session.exitCode !== null ? `Process exited with code ${session.exitCode}. ` : "The process stopped unexpectedly. "}
                                        Review the terminal output for details, then resume to try again.
                                    </p>
                                ) : session.state === "sleeping" ? (
                                    <p>
                                        {sleepReasonText(session.sleepReason)}
                                        {stoppedAgo && <> Stopped {stoppedAgo}.</>}
                                    </p>
                                ) : (
                                    stoppedAgo && <p>Stopped {stoppedAgo}.</p>
                                )}
                                <p>{resumeHint(session.provider)}</p>
                            </div>
                            <Button
                                autoFocus={active && focusOnActive}
                                disabled={busy !== null}
                                aria-busy={busy === "resume"}
                                onClick={() => void resume()}
                                className="dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 dark:focus-visible:ring-zinc-300/50"
                            >
                                {busy === "resume" ? <Spinner /> : <IconPlayerPlay />}
                                {busy === "resume" ? "Resuming" : "Resume"}
                            </Button>
                            <div role="status" aria-live="polite" className="text-xs">
                                {busy === "resume" && <span className="sr-only">Resuming</span>}
                                {resumeError && <p className="text-destructive dark:text-red-300">Could not resume: {resumeError}</p>}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
