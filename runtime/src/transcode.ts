import { spawn, type ChildProcess } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./errors.js";

/**
 * On-the-fly conversion of audio/video the webview cannot decode into fragmented MP4 (H.264 + AAC), streamed to the client.
 * ffmpeg parses untrusted files, so it runs as the user's uid, niced, with a wall clock, a per-user concurrency cap,
 * a protocol whitelist (no network, no playlist-driven file reads) and is killed when the client goes away.
 * The input is an already-verified descriptor handed to the child as fd 3, never a user-supplied path.
 */

export const TRANSCODE_MAX_CONCURRENT_PER_USER = 2;
export const TRANSCODE_WALL_CLOCK_MS = 4 * 60 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 20_000;
export const TRANSCODE_MAX_START_SECONDS = 7 * 24 * 3600;
export const TRANSCODE_MAX_HEIGHT = 1080;

/** What `ffprobe` found, reduced to what the plan needs. */
export interface MediaProbe {
  videoCodec: string | null;
  videoPixFmt: string | null;
  audioCodec: string | null;
  durationSeconds: number | null;
}

export interface TranscodePlan {
  /** audio-only output is served as audio/mp4, everything else as video/mp4. */
  audioOnly: boolean;
  copyVideo: boolean;
  copyAudio: boolean;
  startSeconds: number;
}

const WEB_PIX_FMTS = new Set(["yuv420p", "yuvj420p"]);

export function planTranscode(probe: MediaProbe, startSeconds = 0): TranscodePlan {
  const audioOnly = probe.videoCodec === null;
  return {
    audioOnly,
    copyVideo: !audioOnly && probe.videoCodec === "h264" && !!probe.videoPixFmt && WEB_PIX_FMTS.has(probe.videoPixFmt),
    copyAudio: probe.audioCodec === "aac",
    startSeconds: Number.isFinite(startSeconds) && startSeconds > 0 ? Math.min(startSeconds, TRANSCODE_MAX_START_SECONDS) : 0,
  };
}

/** Parse the `start` query value; anything that is not a finite non-negative number of seconds is rejected. */
export function parseStart(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^\d{1,7}(\.\d{1,3})?$/.test(value)) throw new HttpError(400, "invalid_start", "start must be a number of seconds");
  const seconds = Number(value);
  if (seconds > TRANSCODE_MAX_START_SECONDS) throw new HttpError(400, "invalid_start", "start is out of range");
  return seconds;
}

/** Fixed input: the descriptor is passed to the child as fd 3 and read through ffmpeg's `fd` protocol. */
const INPUT_ARGS = ["-fd", "3", "-i", "fd:"];
const WHITELIST = "fd,pipe";

export function buildProbeArgs(): string[] {
  return [
    "-v", "error", "-protocol_whitelist", WHITELIST,
    "-print_format", "json", "-show_entries", "stream=codec_type,codec_name,pix_fmt:stream_disposition=attached_pic:format=duration",
    ...INPUT_ARGS,
  ];
}

/** Pure: plan -> ffmpeg argv (without the binary). No shell is involved anywhere. */
export function buildTranscodeArgs(plan: TranscodePlan): string[] {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", WHITELIST];
  if (plan.startSeconds > 0) args.push("-ss", String(plan.startSeconds));
  args.push(...INPUT_ARGS, "-sn", "-dn", "-threads", "2");
  if (plan.audioOnly) {
    args.push("-map", "0:a:0", "-vn");
  } else {
    args.push("-map", "0:v:0", "-map", "0:a:0?");
    if (plan.copyVideo) args.push("-c:v", "copy");
    else args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-vf", `scale=-2:min(${TRANSCODE_MAX_HEIGHT}\\,ih)`);
  }
  if (plan.copyAudio) args.push("-c:a", "copy");
  else args.push("-c:a", "aac", "-b:a", "160k", "-ac", "2");
  args.push("-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1");
  return args;
}

export function parseProbe(json: string): MediaProbe {
  const out: MediaProbe = { videoCodec: null, videoPixFmt: null, audioCodec: null, durationSeconds: null };
  let data: { streams?: Array<{ codec_type?: string; codec_name?: string; pix_fmt?: string; disposition?: { attached_pic?: number } }>; format?: { duration?: string } };
  try { data = JSON.parse(json); } catch { return out; }
  for (const stream of data.streams ?? []) {
    if (stream.codec_type === "video" && !stream.disposition?.attached_pic && out.videoCodec === null) { out.videoCodec = stream.codec_name ?? "unknown"; out.videoPixFmt = stream.pix_fmt ?? null; }
    if (stream.codec_type === "audio" && out.audioCodec === null) out.audioCodec = stream.codec_name ?? "unknown";
  }
  const duration = Number(data.format?.duration);
  if (Number.isFinite(duration) && duration >= 0) out.durationSeconds = duration;
  return out;
}

export interface TranscodeEnv {
  ffmpegBin: string;
  ffprobeBin: string;
}

export function transcodeEnv(env: NodeJS.ProcessEnv = process.env): TranscodeEnv {
  return { ffmpegBin: env.FLOQ_FFMPEG || "ffmpeg", ffprobeBin: env.FLOQ_FFPROBE || "ffprobe" };
}

/** Argv for running a helper niced and, on the Linux shard driver, as the shard uid. */
export function wrapCommand(bin: string, args: string[], runAsUid?: number): [string, string[]] {
  const niced: [string, string[]] = ["nice", ["-n", "10", bin, ...args]];
  if (runAsUid === undefined) return niced;
  return ["setpriv", [`--reuid=${runAsUid}`, `--regid=${runAsUid}`, "--clear-groups", niced[0], ...niced[1]]];
}

const SPAWN_ENV = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C" };

function unavailable(): HttpError {
  return new HttpError(501, "transcode_unavailable", "Converting this file for playback is not available on this server (ffmpeg is not installed). Download it instead.");
}

/** Per-user admission control. */
export class TranscodeLimiter {
  private readonly active = new Map<string, number>();
  constructor(private readonly max = TRANSCODE_MAX_CONCURRENT_PER_USER) {}
  acquire(userId: string): (() => void) | null {
    const count = this.active.get(userId) ?? 0;
    if (count >= this.max) return null;
    this.active.set(userId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(userId) ?? 1) - 1;
      if (left <= 0) this.active.delete(userId); else this.active.set(userId, left);
    };
  }
}

function runProbe(env: TranscodeEnv, handle: FileHandle, runAsUid: number | undefined): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const [file, argv] = wrapCommand(env.ffprobeBin, buildProbeArgs(), runAsUid);
    const child = spawn(file, argv, { stdio: ["ignore", "pipe", "ignore", handle.fd], env: SPAWN_ENV });
    let out = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { if (out.length < 256 * 1024) out += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    child.on("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); reject(error.code === "ENOENT" ? unavailable() : error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new HttpError(415, "transcode_unsupported", "This file could not be read as audio or video."));
      resolve(parseProbe(out));
    });
  });
}

export interface ServeTranscodeOptions {
  userId: string;
  /** Opens a fresh verified descriptor (offset 0) each call; the caller does the path resolution. Caller-owned handles are closed here. */
  open: () => Promise<FileHandle>;
  runAsUid?: number;
  startSeconds: number;
  req: Pick<IncomingMessage, "on">;
  res: ServerResponse;
  limiter: TranscodeLimiter;
  env?: TranscodeEnv;
}

/** Throws HttpError before any header is written (501 no ffmpeg, 415 not media, 429 too many); afterwards streams until done or the client disconnects. */
export async function serveTranscode(options: ServeTranscodeOptions): Promise<void> {
  const env = options.env ?? transcodeEnv();
  const release = options.limiter.acquire(options.userId);
  if (!release) throw new HttpError(429, "too_many_conversions", "Too many files are being converted at once. Try again in a moment.");
  let probeHandle: FileHandle | null = null;
  let mediaHandle: FileHandle | null = null;
  let child: ChildProcess | null = null;
  try {
    probeHandle = await options.open();
    const probe = await runProbe(env, probeHandle, options.runAsUid);
    await probeHandle.close().catch(() => {}); probeHandle = null;
    if (probe.videoCodec === null && probe.audioCodec === null) throw new HttpError(415, "transcode_unsupported", "This file has no audio or video to play.");
    const plan = planTranscode(probe, options.startSeconds);
    mediaHandle = await options.open();
    const [file, argv] = wrapCommand(env.ffmpegBin, buildTranscodeArgs(plan), options.runAsUid);
    const proc = spawn(file, argv, { stdio: ["ignore", "pipe", "pipe", mediaHandle.fd], env: SPAWN_ENV });
    child = proc;
    await new Promise<void>((resolve, reject) => {
      let started = false;
      let stderr = "";
      proc.stderr!.setEncoding("utf8");
      proc.stderr!.on("data", (chunk: string) => { if (stderr.length < 4096) stderr += chunk; });
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => proc.kill("SIGKILL"), TRANSCODE_WALL_CLOCK_MS);
      const stop = () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); };
      options.req.on("close", stop);
      options.res.on("close", stop);
      proc.on("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); reject(error.code === "ENOENT" ? unavailable() : error); });
      proc.stdout!.once("data", (first: Buffer) => {
        started = true;
        options.res.writeHead(200, {
          "Content-Type": plan.audioOnly ? "audio/mp4" : "video/mp4",
          "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
          ...(probe.durationSeconds !== null ? { "X-Media-Duration": String(probe.durationSeconds) } : {}),
        });
        options.res.write(first);
        proc.stdout!.on("data", (chunk: Buffer) => { if (!options.res.write(chunk)) { proc.stdout!.pause(); options.res.once("drain", () => proc.stdout!.resume()); } });
      });
      proc.on("close", (code) => {
        if (!started) {
          clearTimeout(timer);
          if (options.res.destroyed) return resolve();
          return reject(new HttpError(415, "transcode_failed", `Could not convert this file for playback${code ? "" : " (no output)"}.`));
        }
        options.res.end();
        finish();
      });
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await probeHandle?.close().catch(() => {});
    await mediaHandle?.close().catch(() => {});
    release();
  }
}
