import { memo, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { MONO_FONT_FAMILY, loadMonoFont } from "@/lib/fonts";
import { useRuntime } from "@/lib/runtime/store";
import { minimumContrastRatio, terminalTheme, useTerminalDark } from "@/lib/terminal-theme";
import type { ServerFrame, SessionSummary } from "@/lib/runtime/types";
import { cn } from "cn";

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

/** SGR (1006) mouse report: what Claude Code and Codex enable for their fullscreen TUIs. */
function sgrMouse(button: number, col: number, row: number, release: boolean, event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean }): string {
  const code = button + (event.shiftKey ? 4 : 0) + (event.altKey ? 8 : 0) + (event.ctrlKey ? 16 : 0);
  return `\x1b[<${code};${col};${row}${release ? "m" : "M"}`;
}

/**
 * Live mirror of a session's PTY output for the canvas.
 *
 * Unlike SessionTerminal (whose `embedded` mode still fits itself and sends `resize` frames to the PTY),
 * this never resizes the PTY. The local xterm is pinned to the PTY's own cols/rows (taken from the
 * hello/state frames) so TUIs render correctly, then CSS-scaled to the node's width.
 *
 * Read-only by default. With `interactive` (the node is selected) the wheel and mouse clicks reach the
 * agent, so a question with options (Claude's "ask") can be answered from the canvas. Because the xterm
 * is CSS-scaled, xterm's own mouse mapping would be off: cells are computed from the scaled screen rect
 * and sent as SGR mouse reports while the TUI has mouse tracking on; otherwise the wheel scrolls the
 * mirror's own scrollback. Typing still goes through the node's message bar.
 */
export default memo(function SessionMirror({ session, interactive = false }: { session: SessionSummary; interactive?: boolean }) {
  const { client } = useRuntime();
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const id = session.id;
  const dark = useTerminalDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wheelRest = useRef(0);
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
      wsRef.current = ws;
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
        wsRef.current = null;
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

  const sendInput = (data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
  };
  const tracking = () => {
    const term = termRef.current;
    return !!term && term.modes.mouseTrackingMode !== "none";
  };
  /** 1-based cell under the pointer, from the scaled screen rect (xterm's own mapping ignores the CSS scale). */
  const cellAt = (clientX: number, clientY: number): [number, number] | null => {
    const term = termRef.current;
    const screen = stageRef.current?.querySelector<HTMLElement>(".xterm-screen");
    if (!term || !screen) return null;
    const rect = screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const col = Math.min(term.cols, Math.max(1, Math.floor(((clientX - rect.left) / rect.width) * term.cols) + 1));
    const row = Math.min(term.rows, Math.max(1, Math.floor(((clientY - rect.top) / rect.height) * term.rows) + 1));
    return [col, row];
  };

  return (
    <div
      ref={hostRef}
      className={cn("terminal-surface size-full overflow-hidden", interactive && "nodrag nopan nowheel cursor-default")}
      aria-label={interactive ? `Live output of ${session.title}: scroll and click go to the agent` : `Live output of ${session.title} (view only)`}
      onWheel={interactive ? (event) => {
        event.stopPropagation();
        const term = termRef.current;
        if (!term) return;
        // Pixel or line deltas -> whole steps; small trackpad deltas accumulate instead of being dropped.
        const unit = event.deltaMode === 1 ? 1 : event.deltaMode === 2 ? term.rows : 1 / 40;
        wheelRest.current += event.deltaY * unit;
        const steps = Math.trunc(wheelRest.current);
        if (!steps) return;
        wheelRest.current -= steps;
        if (tracking()) {
          const cell = cellAt(event.clientX, event.clientY);
          if (!cell) return;
          const report = sgrMouse(steps < 0 ? 64 : 65, cell[0], cell[1], false, event);
          sendInput(report.repeat(Math.min(Math.abs(steps), 10)));
        } else {
          term.scrollLines(steps * 3);
        }
      } : undefined}
      onPointerDown={interactive ? (event) => {
        if (event.button > 2 || !tracking()) return;
        const cell = cellAt(event.clientX, event.clientY);
        if (!cell) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        sendInput(sgrMouse(event.button, cell[0], cell[1], false, event));
      } : undefined}
      onPointerUp={interactive ? (event) => {
        if (event.button > 2 || !tracking()) return;
        const cell = cellAt(event.clientX, event.clientY);
        if (!cell) return;
        event.stopPropagation();
        sendInput(sgrMouse(event.button, cell[0], cell[1], true, event));
      } : undefined}
      onContextMenu={interactive ? (event) => { if (tracking()) event.preventDefault(); } : undefined}
    >
      <div ref={stageRef} className="pointer-events-none w-max origin-top-left" />
    </div>
  );
});
