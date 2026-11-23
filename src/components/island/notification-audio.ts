import { claimPlayback, decodeWaveform, PLAYBACK_RATES } from '@/lib/audio-playback';
import type { IslandAudioState } from '@/lib/island-contract';

/** Waits before the 2nd, 3rd and 4th try of a file that failed for a passing reason: one press of Play is enough. */
export const AUDIO_RETRY_MS = [600, 1500, 3500];
const passing = (e: unknown) => { const s = (e as { status?: unknown } | null)?.status; return s === 0 || s === 408 || s === 429 || s === 502 || s === 503 || s === 504; };
const messageOf = (e: unknown) => ((e as { status?: unknown } | null)?.status === 404 ? 'This audio is no longer available.' : (e instanceof Error && e.message) || 'The audio could not be loaded.');
interface AudioFile { url: string; peaks: number[] | null; duration: number | null }
export interface NotificationAudioDeps {
  /** The file of a notification, fetched with the user's runtime session. */
  fetch: (id: string) => Promise<Blob>;
  /** Called once per notification, when it first really plays. */
  played?: (id: string) => void;
  publish: (state: IslandAudioState | null) => void;
  retryMs?: number[];
}

/**
 * Plays the audio of island notifications in the main window: one element, one notification at a time. The island only sends what the user
 * did (play, pause, seek, speed) and draws from the state published here, so collapsing, expanding or re-rendering the island never touches
 * playback. Files are fetched once and kept while their notification is on the island.
 */
export class NotificationAudio {
  private el: HTMLAudioElement;
  private id: string | null = null;
  private status: IslandAudioState['status'] = 'paused';
  private rate = 1;
  private error: string | undefined;
  private rev = 0;
  /** Where to start once the file is there (a seek before or while it loads). */
  private pending: number | null = null;
  private wantPlay = false;
  private files = new Map<string, AudioFile>();
  private loads = new Map<string, Promise<AudioFile>>();
  private playedIds = new Set<string>();
  private release: (() => void) | null = null;
  private disposed = false;
  private readonly pauseForOther = () => { if (this.id) this.pause(this.id); };

  constructor(private deps: NotificationAudioDeps) {
    this.el = new Audio();
    this.el.preload = 'auto';
    const on = (name: string, fn: () => void) => this.el.addEventListener(name, () => { if (!this.disposed && this.id && this.loaded()) fn(); });
    on('playing', () => { this.status = 'playing'; this.error = undefined; if (!this.playedIds.has(this.id!)) { this.playedIds.add(this.id!); this.deps.played?.(this.id!); } this.emit(); });
    on('pause', () => { if (this.status === 'playing') this.status = 'paused'; this.emit(); });
    on('ended', () => { this.status = 'paused'; this.wantPlay = false; this.el.currentTime = 0; this.emit(); });
    on('seeked', () => this.emit());
    on('durationchange', () => this.emit());
    on('waiting', () => this.emit());
    on('error', () => { this.status = 'error'; this.wantPlay = false; this.error = 'This audio cannot be played here.'; this.emit(); });
  }

  /** The element has this notification's file. */
  private loaded() { const f = this.id ? this.files.get(this.id) : undefined; return !!f && this.el.src === f.url; }
  private emit() {
    if (this.disposed) return;
    if (!this.id) { this.deps.publish(null); return; }
    const f = this.files.get(this.id), loaded = this.loaded();
    const native = loaded && Number.isFinite(this.el.duration) && this.el.duration > 0 ? this.el.duration : null;
    this.deps.publish({
      id: this.id, status: this.status, position: this.pending ?? (loaded ? this.el.currentTime : 0), at: Date.now(), duration: native ?? f?.duration ?? null,
      rate: this.rate, peaks: f?.peaks ?? null, ...(this.error ? { error: this.error } : {}), rev: ++this.rev,
    });
  }
  private unload() { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); }
  private select(id: string) {
    if (this.id === id) return;
    this.unload();
    this.id = id; this.status = 'paused'; this.error = undefined; this.pending = null; this.wantPlay = false;
  }
  private load(id: string): Promise<AudioFile> {
    const hit = this.files.get(id);
    if (hit) return Promise.resolve(hit);
    let job = this.loads.get(id);
    if (!job) {
      const waits = this.deps.retryMs ?? AUDIO_RETRY_MS;
      job = (async () => {
        for (let n = 0; ; n++) {
          try {
            const blob = await this.deps.fetch(id);
            const file: AudioFile = { url: URL.createObjectURL(blob), peaks: null, duration: null };
            if (this.disposed) { URL.revokeObjectURL(file.url); throw new Error('stopped'); }
            this.files.set(id, file);
            // The real bars (and the length, for files whose header does not say) arrive a moment later.
            void decodeWaveform(blob).then((w) => { if (!w || this.files.get(id) !== file) return; file.peaks = w.peaks; file.duration = w.duration; if (this.id === id) this.emit(); });
            return file;
          } catch (e) {
            if (this.disposed || !passing(e) || n >= waits.length) throw e;
            await new Promise((r) => setTimeout(r, waits[n]));
          }
        }
      })().finally(() => { this.loads.delete(id); });
      this.loads.set(id, job);
    }
    return job;
  }
  private fail(id: string, e: unknown) {
    if (this.id !== id || this.disposed) return;
    this.status = 'error'; this.wantPlay = false; this.error = (e as { name?: string } | null)?.name === 'NotAllowedError' ? 'Open Floq once to allow sound, then press play.' : messageOf(e);
    this.emit();
  }

  async play(id: string): Promise<void> {
    this.select(id);
    this.wantPlay = true; this.error = undefined;
    this.release = claimPlayback(this.pauseForOther);
    let file = this.files.get(id);
    if (!file) {
      this.status = 'loading'; this.emit();
      try { file = await this.load(id); } catch (e) { this.fail(id, e); return; }
      if (this.id !== id || this.disposed) return;
      if (!this.wantPlay) { if (this.status === 'loading') { this.status = 'paused'; this.emit(); } return; }
    }
    if (this.el.src !== file.url) this.el.src = file.url;
    this.el.defaultPlaybackRate = this.rate; this.el.playbackRate = this.rate;
    if (this.pending !== null) { this.el.currentTime = this.pending; this.pending = null; }
    if (this.status !== 'playing') { this.status = 'loading'; this.emit(); }
    try { await this.el.play(); } catch (e) { if ((e as { name?: string } | null)?.name !== 'AbortError') this.fail(id, e); }
  }
  pause(id: string): void {
    if (this.id !== id) return;
    this.wantPlay = false;
    if (this.loaded() && !this.el.paused) { this.el.pause(); return; }
    if (this.status === 'loading') { this.status = 'paused'; this.emit(); }
  }
  /** A seek on the notification that is not the current one starts it from there, like pressing its waveform in a chat. */
  seek(id: string, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    if (this.id === id && this.loaded()) { this.el.currentTime = Number.isFinite(this.el.duration) ? Math.min(seconds, this.el.duration) : seconds; this.emit(); return; }
    const fresh = this.id !== id;
    this.select(id);
    this.pending = seconds;
    if (fresh) void this.play(id); else this.emit();
  }
  setRate(id: string, rate: number): void {
    if (!(PLAYBACK_RATES as readonly number[]).includes(rate)) return;
    this.select(id);
    this.rate = rate; this.el.defaultPlaybackRate = rate; this.el.playbackRate = rate;
    this.emit();
  }
  /** Stops and forgets the current notification (it was dismissed). */
  stop(): void {
    if (!this.id) return;
    this.unload();
    this.id = null; this.status = 'paused'; this.pending = null; this.wantPlay = false; this.error = undefined;
    this.release?.(); this.release = null;
    this.emit();
  }
  /** Notifications still on the island: everything else is stopped and its file dropped. */
  retain(ids: ReadonlySet<string>): void {
    if (this.id && !ids.has(this.id)) this.stop();
    for (const [id, f] of this.files) if (!ids.has(id)) { URL.revokeObjectURL(f.url); this.files.delete(id); this.playedIds.delete(id); }
  }
  dispose(): void {
    this.unload();
    this.disposed = true; this.id = null;
    this.release?.(); this.release = null;
    for (const f of this.files.values()) URL.revokeObjectURL(f.url);
    this.files.clear();
  }
}
