import { memo, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { MONO_FONT_FAMILY, loadMonoFont } from "@/lib/fonts";
import { useRuntime } from "@/lib/runtime/store";
import { minimumContrastRatio, terminalTheme, useTerminalDark } from "@/lib/terminal-theme";
import type { ServerFrame, SessionSummary } from "@/lib/runtime/types";

/** Read-only mirror: same palettes as the interactive terminal, with the cursor hidden (painted as background). */
const mirrorTheme = (dark: boolean) => {
  const t = terminalTheme(dark);
  return { ...t, cursor: t.background, cursorAccent: t.background };
};

// Registry so menus can copy the latest output and inactive nodes can show the last lines.
const snapshots = new Map<string, () => string>();
const lastLines = new Map<string, string>();
export const getMirrorText = (id: string): string | null => snapshots.get(id)?.() ?? lastLines.get(id) ?? null;
export const getMirrorTail = (id: string): string | null => lastLines.get(id) ?? null;

function bufferText(term: Terminal, maxLines = 400): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = Math.max(0, buffer.length - maxLines); i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n").replace(/\s+$/, "");
}

/**
 * Read-only live mirror of a session's PTY output for the canvas.
 *
 * Unlike SessionTerminal (whose `embedded` mode still fits itself and sends `resize` frames to the PTY),
 * this never sends anything to the stream: no input, no resize. The local xterm is pinned to the PTY's own
 * cols/rows (taken from the hello/state frames) so TUIs render correctly, then CSS-scaled to the node's width.
 */
export default memo(function SessionMirror({ session }: { session: SessionSummary }) {
  const { client } = useRuntime();
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const id = session.id;
  const dark = useTerminalDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const termRef = useRef<Terminal | null>(null);
  const initial = useRef({ cols: session.cols, rows: session.rows });

  useEffect(() => {
    const host = hostRef.current;
    const stage = stageRef.current;
    if (!client || !host || !stage) return;
    let disposed = false;
    let term: Terminal | null = null;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: ResizeObserver | undefined;
    let lastSeq = 0;
    let run: string | null = null;
    let attempt = 0;

    const rescale = () => {
      const screen = stage.querySelector<HTMLElement>(".xterm-screen");
      if (!screen || !screen.offsetWidth || !host.clientWidth) return;
      const scale = host.clientWidth / screen.offsetWidth;
      // Anchor the bottom of the screen so the newest lines stay visible when the node is shorter.
      const shift = Math.min(0, host.clientHeight - screen.offsetHeight * scale);
      stage.style.transform = `translateY(${shift}px) scale(${scale})`;
    };

    const connect = () => {
      if (disposed || !term) return;
      const t = term;
      ws = new WebSocket(client.streamUrl(id, lastSeq));
      ws.onopen = () => { attempt = 0; };
      ws.onmessage = (event) => {
        let frame: ServerFrame;
        try { frame = JSON.parse(String(event.data)) as ServerFrame; } catch { return; }
        if (frame.type === "hello" || frame.type === "state") {
          const s = frame.session;
          if (frame.type === "hello") {
            const startedAt = String(s.startedAt);
            if ((run !== null && run !== startedAt) || lastSeq > s.seq) { t.reset(); lastSeq = 0; ws?.close(); }
            run = startedAt;
          }
          if (s.cols > 0 && s.rows > 0 && (s.cols !== t.cols || s.rows !== t.rows)) {
            t.resize(Math.min(s.cols, 400), Math.min(s.rows, 200)); // local only
            requestAnimationFrame(rescale);
          }
        } else if (frame.type === "output" && frame.seq > lastSeq) {
          lastSeq = frame.seq;
          t.write(frame.data);
        }
      };
      ws.onclose = () => {
        ws = null;
        if (!disposed) timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt++));
      };
    };

    void loadMonoFont().catch(() => undefined).then(() => {
      if (disposed) return;
      term = new Terminal({
        cols: Math.min(initial.current.cols || 120, 400),
        rows: Math.min(initial.current.rows || 30, 200),
        fontSize: 13,
        fontFamily: MONO_FONT_FAMILY,
        minimumContrastRatio: minimumContrastRatio(darkRef.current),
        theme: mirrorTheme(darkRef.current),
        scrollback: 200,
        disableStdin: true,
        cursorBlink: false,
        cursorInactiveStyle: "none",
        allowProposedApi: true,
      });
      term.open(stage);
      termRef.current = term;
      snapshots.set(id, () => (term ? bufferText(term) : ""));
      observer = new ResizeObserver(rescale);
      observer.observe(host);
      requestAnimationFrame(rescale);
      connect();
    });

    return () => {
      disposed = true;
      clearTimeout(timer);
      observer?.disconnect();
      ws?.close();
      if (term) lastLines.set(id, bufferText(term, 14));
      snapshots.delete(id);
      term?.dispose();
      termRef.current = null;
    };
  }, [client, id]);

  // Live theme switch: no remount, buffer and stream untouched.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.minimumContrastRatio = minimumContrastRatio(dark);
    term.options.theme = mirrorTheme(dark);
    term.refresh(0, term.rows - 1);
  }, [dark]);

  return (
    <div ref={hostRef} className="terminal-surface size-full overflow-hidden" aria-label={`Live output of ${session.title} (view only)`}>
      <div ref={stageRef} className="pointer-events-none w-max origin-top-left" />
    </div>
  );
});
