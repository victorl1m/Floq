import { memo, useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { IconLoader2, IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-react";
import { formatClock } from "@/lib/audio-playback";
import "./voice-player.css";

export interface VoicePlayerProps {
  playing: boolean;
  /** The file is on its way: the button shows a spinner. */
  loading?: boolean;
  /** Seconds; 0 while unknown. */
  duration: number;
  rate: number;
  /** Bar heights from 0 to 1. */
  peaks: readonly number[];
  /**
   * Where playback is, in seconds. Read on every animation frame while `playing` and once whenever `sync` changes, so the caller never
   * has to put the position in React state.
   */
  position: () => number;
  /** Change it when the position jumped while not playing (a seek, a reset). */
  sync?: unknown;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  /** Left out: no speed button. */
  onRate?: () => void;
  /** "Voice message", or the file name: names the controls for assistive tech. */
  label: string;
  /** Shown next to the time (a file name). */
  name?: string;
  className?: string;
}

const Bars = memo(function Bars({ peaks, on }: { peaks: readonly number[]; on?: boolean }) {
  return <>{peaks.map((p, i) => <i key={i} style={{ height: Math.round(Math.min(1, Math.max(0.06, p)) * 100) + "%" }} data-on={on ? "" : undefined} />)}</>;
});

/**
 * WhatsApp-style player: play/pause, a waveform you can seek, the time, the speed. While it plays, progress is painted from a
 * requestAnimationFrame loop straight onto two elements (the clip of the played bars and the transform of the knob): nothing re-renders.
 * The loop stops when playback stops or the page is hidden; with reduced motion the progress moves once a second.
 */
export const VoicePlayer = memo(function VoicePlayer({ playing, loading, duration, rate, peaks, position, sync, onToggle, onSeek, onRate, label, name, className }: VoicePlayerProps) {
  const track = useRef<HTMLDivElement>(null), played = useRef<HTMLDivElement>(null), knob = useRef<HTMLSpanElement>(null), time = useRef<HTMLSpanElement>(null);
  const live = useRef({ position, duration, playing });
  live.current = { position, duration, playing };
  const shown = useRef({ clock: "", second: -1 });
  const renders = (globalThis as { __fqAudioRenders?: number }).__fqAudioRenders;
  if (renders !== undefined) (globalThis as { __fqAudioRenders?: number }).__fqAudioRenders = renders + 1;

  /** Paints the current position. `coarse`: only when the clock text changes (reduced motion). */
  const paint = useCallback((coarse = false) => {
    const { position: at, duration: d, playing: on } = live.current;
    const raw = at();
    const t = Math.max(0, d > 0 ? Math.min(d, Number.isFinite(raw) ? raw : 0) : Number.isFinite(raw) ? raw : 0);
    const second = Math.floor(t);
    if (coarse && second === shown.current.second) return;
    const f = d > 0 ? t / d : 0;
    if (played.current) played.current.style.clipPath = `inset(0 ${((1 - f) * 100).toFixed(3)}% 0 0)`;
    if (knob.current) knob.current.style.transform = `translate3d(${(f * 100).toFixed(3)}%,0,0)`;
    const clock = formatClock(on || t > 0 || !d ? t : d);
    if (clock !== shown.current.clock || second !== shown.current.second) {
      shown.current = { clock, second };
      if (time.current) time.current.textContent = clock;
      const el = track.current;
      if (el) { el.setAttribute("aria-valuenow", String(Math.round(t))); el.setAttribute("aria-valuetext", d ? `${formatClock(t)} of ${formatClock(d)}` : formatClock(t)); }
    }
  }, []);

  useLayoutEffect(() => { paint(); }, [paint, playing, sync, duration, peaks]);
  useEffect(() => {
    if (!playing) return;
    const reduce = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    let frame = 0;
    const loop = () => { paint(reduce?.matches === true); frame = requestAnimationFrame(loop); };
    const start = () => { cancelAnimationFrame(frame); if (document.visibilityState !== "hidden") frame = requestAnimationFrame(loop); };
    start();
    document.addEventListener("visibilitychange", start);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", start); paint(); };
  }, [playing, paint]);

  const seekAt = (x: number, r: DOMRect) => { const d = live.current.duration; if (d > 0) { onSeek(Math.min(d, Math.max(0, ((x - r.left) / Math.max(1, r.width)) * d))); paint(); } };
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    seekAt(e.clientX, r);
    const move = (ev: PointerEvent) => seekAt(ev.clientX, r);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const onKeyDown = (e: RKeyboardEvent) => {
    const d = live.current.duration;
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onToggle(); return; }
    if (!d) return;
    const now = Math.min(d, Math.max(0, live.current.position()));
    const to = e.key === "ArrowRight" || e.key === "ArrowUp" ? now + 5 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? now - 5 : e.key === "Home" ? 0 : e.key === "End" ? d : null;
    if (to === null) return;
    e.preventDefault(); e.stopPropagation();
    onSeek(Math.min(d, Math.max(0, to))); paint();
  };
  const lower = label.toLowerCase();
  return (
    <div className={"fq-audio" + (className ? " " + className : "")} data-playing={playing ? "" : undefined} data-loading={loading ? "" : undefined}>
      <button type="button" className="fq-audio-play" aria-label={(playing ? "Pause " : "Play ") + lower} aria-busy={loading || undefined} onClick={onToggle}>
        {loading ? <IconLoader2 className="fq-audio-spin" /> : playing ? <IconPlayerPauseFilled /> : <IconPlayerPlayFilled />}
      </button>
      <div ref={track} className="fq-audio-track" role="slider" tabIndex={0} aria-label={label + " position"} aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown}>
        <div className="fq-audio-bars"><Bars peaks={peaks} /></div>
        <div ref={played} className="fq-audio-bars fq-audio-bars-on" aria-hidden="true"><Bars peaks={peaks} on /></div>
        <span ref={knob} className="fq-audio-knob" />
      </div>
      {onRate && <button type="button" className="fq-audio-rate" aria-label={"Playback speed " + rate + "x"} onClick={onRate}>{rate}x</button>}
      <div className="fq-audio-meta">
        <span ref={time} className="fq-audio-time" />
        {name && <span className="fq-audio-name" title={name}>{name}</span>}
      </div>
    </div>
  );
});
