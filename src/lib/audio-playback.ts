/** What every audio player of the app shares: one sound at a time, and the bars of a waveform. */

let owner: (() => void) | null = null;
/**
 * Call when a player starts: whatever was playing (a voice note in a chat, the audio of an island notification) is paused.
 * Returns the release to call when this player stops being the one that plays.
 */
export function claimPlayback(pause: () => void): () => void {
  if (owner && owner !== pause) { const previous = owner; owner = null; try { previous(); } catch { /* a player that is gone */ } }
  owner = pause;
  return () => { if (owner === pause) owner = null; };
}

export const PLAYBACK_RATES = [1, 1.5, 2] as const;
export const nextPlaybackRate = (rate: number): number => PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(rate as 1) + 1) % PLAYBACK_RATES.length];
export const WAVEFORM_BARS = 40;

/** Stable pseudo-random bars for a file whose real peaks are not known yet (same seed, same shape). */
export function placeholderPeaks(seed: string, n = WAVEFORM_BARS): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) { h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; out.push(0.15 + ((h >>> 8) % 1000) / 1000 * 0.85); }
  return out;
}

/** Reduces samples to n bars scaled to 0.12-1. */
export function samplePeaks(samples: ArrayLike<number>, n = WAVEFORM_BARS): number[] {
  const out: number[] = [], step = Math.max(1, Math.floor(samples.length / n));
  for (let i = 0; i < n; i++) {
    let max = 0;
    for (let j = i * step; j < Math.min(samples.length, (i + 1) * step); j++) { const v = Math.abs(samples[j]); if (v > max) max = v; }
    out.push(max);
  }
  const top = Math.max(...out, 1e-6);
  return out.map((v) => Math.round(Math.max(0.12, v / top) * 100) / 100);
}

/** The real bars and length of an audio file, or null when the browser cannot decode it (or it is too large to be worth it). */
export async function decodeWaveform(blob: Blob, n = WAVEFORM_BARS): Promise<{ peaks: number[]; duration: number } | null> {
  const g = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const AC = g.AudioContext ?? g.webkitAudioContext;
  if (!AC || blob.size > 6 * 1024 * 1024) return null;
  let ctx: AudioContext | null = null;
  try {
    ctx = new AC();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    return { peaks: samplePeaks(buf.getChannelData(0), n), duration: buf.duration };
  } catch { return null; }
  finally { void ctx?.close().catch(() => undefined); }
}

/** 0:07, 12:40, 1:02:03. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}
