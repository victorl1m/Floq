import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { claimPlayback, cn, decodeWaveform, nextPlaybackRate, VoicePlayer, WAVEFORM_BARS } from "@/plugins/kit";
import type { Message } from "@whatsapp-shared/chat";
import { docKind, fakePeaks, fitBox, Lru } from "@whatsapp-shared/format";
import { formatBytes, formatDuration } from "./composer-utils";
import { useWa, errorStatus, errorCode, type Api } from "./context";
import { Avatar } from "./avatar";
import { IconBan, IconDownload, IconFileText, IconImage, IconPlay, IconRefresh, IconSticker, IconVideo } from "./icons-bubbles";
import { Spinner } from "./icons";

/** A loaded file: bytes as a Blob plus an object URL. Entries in use (refs > 0) are never evicted. */
export interface MediaEntry { url: string; blob: Blob; mime: string; filename: string; size: number; refs: number }
const MAX_ENTRIES = 60;
const cache = new Lru<MediaEntry>(MAX_ENTRIES, (_k, e) => URL.revokeObjectURL(e.url), (e) => e.refs <= 0);
const inflight = new Map<string, Promise<MediaEntry>>();
const peaksCache = new Lru<number[]>(200);

export const mediaCacheSize = () => cache.size;
export const peekMedia = (id: string) => cache.get(id);

function b64Blob(data: string, mime: string): Blob {
  const bin = atob(data), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

/** True when the server said the file is gone for good (a 404). Anything else (WhatsApp busy, the network, a restart) passes. */
export const mediaGone = (e: unknown) => errorStatus(e) === 404 || errorCode(e) === "media_unavailable" || errorCode(e) === "no_media";
/** Waits before the 2nd, 3rd and 4th try of a file that failed for a passing reason. */
export const MEDIA_RETRY_MS = [800, 2000, 5000];
/** A conversation full of photos asks for a few files at a time, not all at once. */
const MAX_PARALLEL = 4;
let active = 0;
const waiting: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

/**
 * GET /media?id= once per message id, shared by every bubble, the lightbox and the menu. The server downloads the file from WhatsApp when it
 * does not have it yet; a passing failure is tried again by itself (MEDIA_RETRY_MS), a file that is gone fails at once.
 */
export function fetchMedia(api: Api, id: string): Promise<MediaEntry> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(id);
  if (!p) {
    const once = () => slot(() => api<{ mime: string; filename: string; size: number; data: string }>("/media?id=" + encodeURIComponent(id)));
    p = (async () => {
      for (let n = 0; ; n++) {
        try {
          const r = await once();
          if (!r || typeof r.data !== "string") throw Object.assign(new Error("No file"), { status: 404, code: "media_unavailable" });
          const blob = b64Blob(r.data, r.mime);
          const e: MediaEntry = { url: URL.createObjectURL(blob), blob, mime: r.mime || blob.type, filename: r.filename || "file", size: r.size ?? blob.size, refs: 0 };
          cache.set(id, e);
          return e;
        } catch (e) {
          if (mediaGone(e) || n >= MEDIA_RETRY_MS.length) throw e;
          await new Promise((r) => setTimeout(r, MEDIA_RETRY_MS[n]));
        }
      }
    })().finally(() => { inflight.delete(id); });
    inflight.set(id, p);
  }
  return p;
}

/** "unavailable": WhatsApp no longer has the file. "error": it could not be loaded after the automatic tries. Both offer Retry. */
export type MediaStatus = "idle" | "loading" | "ready" | "error" | "unavailable";
/** Loads a message's file. With auto it starts as soon as the element is on screen, else on load(). `available: false` means an earlier try found the file gone. */
export function useMedia(m: Message, auto = false, visible = true) {
  const { api } = useWa();
  const id = m.id;
  const [entry, setEntry] = useState<MediaEntry | undefined>(() => cache.get(id));
  const [status, setStatus] = useState<MediaStatus>(() => (cache.get(id) ? "ready" : m.media?.available === false ? "unavailable" : "idle"));
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!entry) return; entry.refs++; return () => { entry.refs--; cache.trim(); }; }, [entry]);
  const load = useCallback(() => {
    setStatus("loading");
    fetchMedia(api, id).then(
      (e) => { if (alive.current) { setEntry(e); setStatus("ready"); } },
      (e) => { if (alive.current) setStatus(mediaGone(e) ? "unavailable" : "error"); },
    );
  }, [api, id]);
  useEffect(() => { if (auto && visible && status === "idle" && !m.localUrl) load(); }, [auto, visible, status, load, m.localUrl]);
  return { status, entry, url: m.localUrl ?? entry?.url, load, retry: load };
}

/** True once the element has been near the viewport. */
export function useInView<T extends Element>(rootMargin = "320px") {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, rootMargin]);
  return [ref, seen] as const;
}

/** Saves a message's file through a temporary <a download>. */
export async function downloadMedia(api: Api, m: Message): Promise<void> {
  const e = m.localUrl && !cache.has(m.id) ? undefined : await fetchMedia(api, m.id);
  const a = document.createElement("a");
  a.href = e?.url ?? m.localUrl ?? "";
  a.download = m.media?.filename || e?.filename || "file";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export const GONE_TEXT = "Not available here. Open WhatsApp on your phone to view it.";
export const FAILED_TEXT = "Could not load this file.";
/** "Not available here" (the file is gone) or "Could not load" (failed, the file may still be there), with a retry. */
export function MediaGone({ onRetry, busy, compact, failed }: { onRetry: () => void; busy?: boolean; compact?: boolean; failed?: boolean }) {
  return (
    <div className={cn("wa-gone", compact && "wa-gone-c")} role="status" data-state={failed ? "failed" : "gone"}>
      <IconBan />
      <span>{failed ? FAILED_TEXT : GONE_TEXT}</span>
      <button type="button" className="wa-linkbtn" onClick={onRetry} disabled={busy}><IconRefresh />Retry</button>
    </div>
  );
}

const box = (m: Message, sticker?: boolean): CSSProperties => {
  const b = sticker ? stickerBox(m.media?.width, m.media?.height) : fitBox(m.media?.width, m.media?.height);
  return { width: b.width, aspectRatio: b.width + " / " + b.height, maxWidth: "100%" };
};

/** WhatsApp shows stickers at about 160px whatever their file size (512x512 usually), never stretched. */
export const STICKER_PX = 160;
const stickerBox = (w?: number | null, h?: number | null) => {
  if (!w || !h || w <= 0 || h <= 0) return { width: STICKER_PX, height: STICKER_PX };
  const k = STICKER_PX / Math.max(w, h);
  return { width: Math.max(48, Math.round(w * k)), height: Math.max(48, Math.round(h * k)) };
};
/** A sticker the inbox cannot draw (a lottie animation, a file the browser cannot decode): a still in its place. */
export function StickerStill({ m, label = "Sticker" }: { m: Message; label?: string }) {
  return (
    <div className="wa-img wa-sticker wa-sticker-still" style={box(m, true)} role="img" aria-label={m.media?.lottie ? "Animated sticker (shown as a still)" : label} title={m.media?.lottie ? "Animated sticker. Open WhatsApp on your phone to see it move." : undefined}>
      <IconSticker /><span>{label}</span>
    </div>
  );
}

/** Image or sticker: reserves its box from the file's size, loads when scrolled into view (and is kept: the file is cached as it arrives), click opens the lightbox. */
export function ImageMedia({ m, sticker, onOpen }: { m: Message; sticker?: boolean; onOpen?: (id: string) => void }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const still = Boolean(sticker && (m.media?.lottie || (m.media?.mime && !m.media.mime.startsWith("image/"))));
  const { status, url, retry, entry } = useMedia(m, !still, seen);
  const [decoded, setDecoded] = useState(false);
  const [broken, setBroken] = useState(false);
  const alt = sticker ? (m.media?.animated ? "Animated sticker" : "Sticker") : m.body ? "Photo: " + m.body : "Photo";
  // A lottie sticker, or one whose file turned out not to be an image: a still, like WhatsApp Web shows for what it cannot play.
  if (still || (sticker && (broken || (entry && entry.mime && !entry.mime.startsWith("image/"))))) return <StickerStill m={m} />;
  return (
    <div ref={ref} className={cn("wa-img", sticker && "wa-sticker")} style={box(m, sticker)}>
      {url ? (
        <button type="button" className="wa-img-btn" aria-label={"Open " + alt.toLowerCase()} onClick={() => onOpen?.(m.id)} disabled={!onOpen}>
          <img src={url} alt={alt} decoding="async" draggable={false} className={cn(decoded && "wa-in")} onLoad={() => setDecoded(true)} onError={() => { if (sticker) setBroken(true); }} />
        </button>
      ) : status === "unavailable" || status === "error" ? (
        <MediaGone onRetry={retry} compact failed={status === "error"} />
      ) : (
        <div className="wa-skel" aria-busy="true" aria-label="Loading photo">{status === "loading" ? <Spinner /> : <IconImage />}</div>
      )}
    </div>
  );
}

/** Video: a poster with a play button; a click loads it and plays inline. A gif plays muted in a loop as soon as it is in view. */
export function VideoMedia({ m }: { m: Message }) {
  const gif = Boolean(m.media?.gif);
  const [ref, seen] = useInView<HTMLDivElement>();
  const [armed, setArmed] = useState(false);
  const { status, url, load, retry } = useMedia(m, gif, seen);
  const dur = m.media?.duration;
  useEffect(() => { if (armed && status === "idle") load(); }, [armed, status, load]);
  return (
    <div ref={ref} className="wa-img wa-video" style={box(m)}>
      {url && (armed || gif) ? (
        <video src={url} className="wa-in" controls={!gif} autoPlay muted={gif} loop={gif} playsInline preload="metadata" aria-label={gif ? "GIF" : "Video"} />
      ) : status === "unavailable" || status === "error" ? (
        <MediaGone onRetry={retry} compact failed={status === "error"} />
      ) : (
        <button type="button" className="wa-vposter" aria-label={"Play video" + (dur ? ", " + formatDuration(dur * 1000) : "")} onClick={() => { setArmed(true); if (status === "idle") load(); }}>
          <span className="wa-vplay">{armed && status === "loading" ? <Spinner /> : <IconPlay />}</span>
          <span className="wa-vmeta"><IconVideo />{dur ? formatDuration(dur * 1000) : gif ? "GIF" : "Video"}</span>
        </button>
      )}
    </div>
  );
}

/** Document card: icon by extension, file name, size and a download button. */
export function DocumentMedia({ m }: { m: Message }) {
  const { api } = useWa();
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState<"" | "gone" | "failed">(m.media?.available === false ? "gone" : "");
  const name = m.media?.filename || m.body || "Document";
  const k = docKind(name, m.media?.mime);
  const go = async () => {
    setBusy(true);
    try { await downloadMedia(api, m); setGone(""); }
    catch (e) { setGone(mediaGone(e) ? "gone" : "failed"); }
    finally { setBusy(false); }
  };
  return (
    <div className="wa-doc-w">
      <div className="wa-doc">
        <span className={cn("wa-doc-ico", "wa-k-" + k.kind)} aria-hidden="true">{k.ext ? <b>{k.ext.slice(0, 4)}</b> : <IconFileText />}</span>
        <span className="wa-doc-t"><b title={name}>{name}</b><span>{[k.ext.toUpperCase(), m.media?.size ? formatBytes(m.media.size) : ""].filter(Boolean).join(" · ") || "Document"}</span></span>
        <button type="button" className="wa-doc-dl" aria-label={"Download " + name} title="Download" disabled={busy || gone === "gone"} onClick={() => void go()}>{busy ? <Spinner /> : <IconDownload />}</button>
      </div>
      {gone && <MediaGone onRetry={() => void go()} busy={busy} compact failed={gone === "failed"} />}
    </div>
  );
}

// ---- voice notes and audio ----

/**
 * WhatsApp-style player (the app's shared VoicePlayer): play/pause, a seekable waveform, elapsed / total time, speed 1x / 1.5x / 2x; only one
 * sound plays at a time in the whole app. Progress is painted by the player from the audio element's clock on every frame: nothing here
 * (and so nothing in the message list) re-renders while it plays.
 */
export function AudioPlayer({ m, ptt }: { m: Message; ptt?: boolean }) {
  const { me, chats } = useWa();
  const { status, entry, url, load, retry } = useMedia(m);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [dur, setDur] = useState(m.media?.duration ?? 0);
  const [speed, setSpeed] = useState(1);
  const [want, setWant] = useState(false);
  /** Bumped when the position jumps while not playing, so the player repaints once. */
  const [sync, setSync] = useState(0);
  /** A position chosen before the file is there. */
  const seekTo = useRef<number | null>(null);
  const release = useRef<(() => void) | null>(null);
  const [peaks, setPeaks] = useState<number[]>(() => peaksCache.get(m.id) ?? fakePeaks(m.id, WAVEFORM_BARS));
  // Tests count renders here (and in the player) to prove that playing re-renders nothing.
  const probe = globalThis as { __fqAudioRenders?: number };
  if (probe.__fqAudioRenders !== undefined) probe.__fqAudioRenders++;

  useEffect(() => {
    if (!entry || !ptt || peaksCache.has(m.id)) return;
    let live = true;
    void decodeWaveform(entry.blob).then((w) => { if (w && live) { peaksCache.set(m.id, w.peaks); setPeaks(w.peaks); } });
    return () => { live = false; };
  }, [entry, ptt, m.id]);

  useEffect(() => {
    const a = audio.current;
    if (!a || !url || !want) return;
    setWant(false);
    if (seekTo.current !== null) { a.currentTime = seekTo.current; seekTo.current = null; }
    void a.play().catch(() => undefined);
  }, [url, want]);
  useEffect(() => () => { release.current?.(); }, []);

  const position = useCallback(() => seekTo.current ?? audio.current?.currentTime ?? 0, []);
  const toggle = useCallback(() => {
    const a = audio.current;
    if (!url || !a) { setWant(true); if (status === "idle" || status === "error") load(); return; }
    if (a.paused) void a.play().catch(() => undefined); else a.pause();
  }, [url, status, load]);
  const seek = useCallback((to: number) => {
    const a = audio.current;
    if (a && url) a.currentTime = to;
    else { seekTo.current = to; setWant(true); if (status === "idle" || status === "error") load(); }
    setSync((n) => n + 1);
  }, [url, status, load]);
  const cycle = useCallback(() => setSpeed((s) => { const next = nextPlaybackRate(s); if (audio.current) audio.current.playbackRate = next; return next; }), []);

  const who = m.fromMe ? { chatId: "me", name: me?.name ?? "" } : (chats.find((c) => c.chatId === m.sender) ?? { chatId: m.sender || "?", name: m.senderName ?? "" });
  if (status === "unavailable") return <MediaGone onRetry={retry} compact />;
  return (
    <div className={cn("wa-audio", ptt && "wa-ptt", m.fromMe && "wa-audio-me")}>
      {ptt && !m.fromMe && <Avatar chat={who} small />}
      <VoicePlayer playing={playing} loading={status === "loading" || (want && status !== "error")} duration={dur} rate={speed} peaks={peaks} position={position} sync={sync}
        onToggle={toggle} onSeek={seek} onRate={playing || speed !== 1 ? cycle : undefined} label={ptt ? "Voice message" : m.media?.filename || "Audio"} name={!ptt ? m.media?.filename || undefined : undefined} />
      {ptt && m.fromMe && <Avatar chat={who} small />}
      {url && (
        <audio ref={audio} src={url} preload="metadata"
          onLoadedMetadata={(e) => { if (Number.isFinite(e.currentTarget.duration)) setDur(e.currentTarget.duration); }}
          onPlay={(e) => { const a = e.currentTarget; release.current = claimPlayback(() => a.pause()); a.playbackRate = speed; setPlaying(true); }}
          onPause={() => setPlaying(false)}
          onEnded={(e) => { setPlaying(false); e.currentTarget.currentTime = 0; setSync((n) => n + 1); }}
          onError={() => setPlaying(false)} />
      )}
    </div>
  );
}
