import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VoicePlayer } from '@/components/audio/voice-player';
import { nextPlaybackRate, placeholderPeaks } from '@/lib/audio-playback';
import { audioPositionAt, type IslandAudioOp, type IslandAudioState } from '@/lib/island-contract';

type Shown = Pick<IslandAudioState, 'status' | 'position' | 'at' | 'duration' | 'rate'>;
const IDLE: Shown = { status: 'paused', position: 0, at: 0, duration: null, rate: 1 };
/** A press with no answer from the main window after this long stops showing as "loading". */
const PENDING_MS = 20000;

/**
 * The player of a notification with audio. The sound itself plays in the main window; this draws its state (from the snapshot) and sends
 * what the user did. A press shows at once (optimistic) and the next state from the main window replaces it. Between snapshots the
 * progress is computed from the clock, so it moves every frame without any message.
 */
export function IslandAudio({ id, label, meta, state, send }: { id: string; label: string; meta: { duration: number | null; waveform: number[] | null }; state: IslandAudioState | null; send: (op: IslandAudioOp, value?: number) => Promise<unknown> }) {
  const [local, setLocal] = useState<{ rev: number | undefined; patch: Partial<Shown>; n: number } | null>(null);
  const rev = state?.rev;
  // Anything newer from the main window wins over what was assumed here.
  const patch = local && local.rev === rev ? local.patch : null;
  const shown: Shown = { ...(state ?? IDLE), ...patch };
  const duration = shown.duration ?? meta.duration ?? 0;
  const live = useRef({ shown, duration });
  live.current = { shown, duration };
  const position = useCallback(() => audioPositionAt({ ...live.current.shown, duration: live.current.duration || null }, Date.now()), []);
  const assume = (next: Partial<Shown>) => setLocal(old => ({ rev, patch: { ...(old && old.rev === rev ? old.patch : {}), ...next }, n: (old?.n ?? 0) + 1 }));
  const dispatch = (op: IslandAudioOp, value?: number) => { void send(op, value).catch(() => setLocal(null)); };
  useEffect(() => {
    if (patch?.status !== 'loading') return;
    const timer = setTimeout(() => setLocal(null), PENDING_MS);
    return () => clearTimeout(timer);
  }, [patch?.status, local?.n]);
  const busy = shown.status === 'playing' || shown.status === 'loading';
  const toggle = useCallback(() => {
    const { shown: s } = live.current;
    if (s.status === 'playing' || s.status === 'loading') { assume({ status: 'paused', position: position(), at: Date.now() }); dispatch('pause'); }
    else { assume({ status: 'loading' }); dispatch('play'); }
  }, [rev, id]);
  const seek = useCallback((seconds: number) => {
    // Pressing the waveform of a note that is not loaded yet starts it from there.
    assume({ position: seconds, at: Date.now(), ...(state ? {} : { status: 'loading' as const }) });
    dispatch('seek', seconds);
  }, [rev, id, !state]);
  const cycle = useCallback(() => {
    const next = nextPlaybackRate(live.current.shown.rate);
    assume({ rate: next, position: position(), at: Date.now() });
    dispatch('rate', next);
  }, [rev, id]);
  const peaks = useMemo(() => state?.peaks ?? meta.waveform ?? placeholderPeaks(id), [state?.peaks, meta.waveform, id]);
  return <div className="island-audio" data-status={shown.status}>
    <VoicePlayer playing={shown.status === 'playing'} loading={shown.status === 'loading'} duration={duration} rate={shown.rate} peaks={peaks} position={position} sync={`${rev}:${local?.n}`} onToggle={toggle} onSeek={seek} onRate={cycle} label={label}/>
    {state?.status === 'error' && !busy && <p role="alert" className="island-audio-error">{state.error || 'The audio could not be played.'}</p>}
  </div>;
}
