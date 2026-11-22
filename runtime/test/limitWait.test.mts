import assert from "node:assert/strict";
import test from "node:test";
import { typeMessage, waitingOnLimit, recentOutput, screenOf } from "../dist/messageDelivery.js";

const BANNER = "\u001b[2K\u001b[38;5;246m●\u001b[39m Usage limit reached · continuing automatically at 7:20pm · esc to cancel\r\n";
const noSleep = async () => undefined;

test("the CLI's own limit wait is recognised only when it is the last thing on screen", () => {
  assert.equal(waitingOnLimit("some work\r\n" + BANNER), true);
  assert.equal(waitingOnLimit(BANNER + "\r\n❯ [Message from agent X] continue\r\n"), true, "queued input under the banner still waits");
  assert.equal(waitingOnLimit(BANNER + "\r\n" + "● Reading 12 files…\r\n".repeat(20)), false, "the CLI moved on");
  assert.equal(waitingOnLimit("an agent printed: Usage limit reached · continuing automatically at 7pm"), false, "no esc hint: not the CLI");
  assert.equal(waitingOnLimit(""), false);
});

test("typing into a session in the limit wait sends Esc first; otherwise no Esc", async () => {
  const a: string[] = [];
  await typeMessage((d) => a.push(d), "continue", { bracketed: true, screen: BANNER, sleep: noSleep });
  assert.deepEqual(a, ["\u001b", "continue", "\r"]);
  const b: string[] = [];
  await typeMessage((d) => b.push(d), "continue", { bracketed: true, screen: "❯ ", sleep: noSleep });
  assert.deepEqual(b, ["continue", "\r"]);
  const c: string[] = [];
  await typeMessage((d) => c.push(d), "continue", { bracketed: true, sleep: noSleep });
  assert.deepEqual(c, ["continue", "\r"]);
});

test("screenOf reads the newest output of Claude sessions only", () => {
  const chunks = [{ data: "old ".repeat(3000) }, { data: BANNER }];
  assert.ok(screenOf({ provider: "claude", replaySince: () => ({ chunks }) })!.endsWith(BANNER));
  assert.equal(screenOf({ provider: "codex", replaySince: () => ({ chunks }) }), undefined);
  assert.equal(recentOutput(chunks, 50).length, 50);
});
