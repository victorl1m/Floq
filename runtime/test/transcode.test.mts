import assert from "node:assert/strict";
import test from "node:test";
import { DownloadLinks } from "../dist/downloadLinks.js";
import { buildProbeArgs, buildTranscodeArgs, parseProbe, parseStart, planTranscode, TranscodeLimiter, wrapCommand } from "../dist/transcode.js";

const web = { videoCodec: "h264", videoPixFmt: "yuv420p", audioCodec: "aac", durationSeconds: 3 };

test("web-safe h264/aac is stream-copied", () => {
  const args = buildTranscodeArgs(planTranscode(web));
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2), ["-c:v", "copy"]);
  assert.ok(args.join(" ").includes("-c:a copy"));
});

test("other codecs go to libx264 + aac, capped at 1080p", () => {
  const args = buildTranscodeArgs(planTranscode({ videoCodec: "wmv3", videoPixFmt: "yuv420p", audioCodec: "wmav2", durationSeconds: null }));
  assert.ok(args.includes("libx264") && args.includes("veryfast") && args.includes("yuv420p"));
  assert.ok(args.some((a) => a.startsWith("scale=-2:min(1080")));
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  const hevc = buildTranscodeArgs(planTranscode({ ...web, videoCodec: "hevc" }));
  assert.ok(hevc.includes("libx264"));
  const tenBit = buildTranscodeArgs(planTranscode({ ...web, videoPixFmt: "yuv420p10le" }));
  assert.ok(tenBit.includes("libx264"), "10-bit h264 is not web safe");
});

test("audio-only output drops video and never maps cover art", () => {
  const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "wmav2" }, { codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } }], format: { duration: "4.5" } }));
  assert.equal(probe.videoCodec, null);
  assert.equal(probe.durationSeconds, 4.5);
  const args = buildTranscodeArgs(planTranscode(probe));
  assert.ok(args.includes("-vn") && !args.includes("libx264"));
});

test("argv is locked down: whitelist, fd input, no subs/data, fragmented mp4 to stdout", () => {
  for (const args of [buildTranscodeArgs(planTranscode(web, 12)), buildProbeArgs()]) {
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "fd,pipe");
    assert.equal(args[args.indexOf("-i") + 1], "fd:");
    assert.equal(args[args.indexOf("-fd") + 1], "3");
    assert.ok(args.indexOf("-fd") < args.indexOf("-i"));
    assert.equal(args.filter((a) => a === "-i").length, 1);
  }
  const args = buildTranscodeArgs(planTranscode(web, 12));
  for (const flag of ["-nostdin", "-hide_banner", "-sn", "-dn"]) assert.ok(args.includes(flag), flag);
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "-ss before -i");
  assert.equal(args[args.indexOf("-movflags") + 1], "frag_keyframe+empty_moov+default_base_moof");
  assert.deepEqual(args.slice(-3), ["-f", "mp4", "pipe:1"]);
});

test("wrapCommand uses an argv array: nice, and setpriv as the shard uid", () => {
  assert.deepEqual(wrapCommand("ffmpeg", ["-x"]), ["nice", ["-n", "10", "ffmpeg", "-x"]]);
  const [file, args] = wrapCommand("ffmpeg", ["-x"], 1234);
  assert.equal(file, "setpriv");
  assert.deepEqual(args.slice(0, 3), ["--reuid=1234", "--regid=1234", "--clear-groups"]);
});

test("start must be a plain number of seconds", () => {
  assert.equal(parseStart(null), 0);
  assert.equal(parseStart("12.5"), 12.5);
  for (const bad of ["-1", "1e9", "abc", "1;rm", "99999999"]) assert.throws(() => parseStart(bad), /start/);
});

test("per-user concurrency cap", () => {
  const limiter = new TranscodeLimiter(2);
  const a = limiter.acquire("u")!, b = limiter.acquire("u")!;
  assert.equal(limiter.acquire("u"), null);
  assert.ok(limiter.acquire("other"));
  a(); a();
  assert.ok(limiter.acquire("u"));
  b();
});

test("download link auth that guards the transcode routes: expired, tampered and wrong-audience links are rejected", () => {
  let now = 1_000_000;
  const links = new DownloadLinks("secret", () => now);
  const issue = (audience: "ws" | "art") => links.issue({ userId: "u", authSessionId: "s", sessionId: "sess", path: "a.avi", audience }).token;
  assert.equal(links.redeem(issue("ws"), "art"), null, "audience mismatch");
  const t = issue("ws");
  assert.ok(links.redeem(t, "ws"));
  assert.equal(links.redeem(t, "ws"), null, "single use");
  const expiring = issue("ws");
  now += 61_000;
  assert.equal(links.redeem(expiring, "ws"), null, "expired");
  const good = issue("ws");
  assert.equal(links.redeem(good.slice(0, -2) + "xx", "ws"), null, "tampered");
});
