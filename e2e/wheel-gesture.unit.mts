// Run: node --experimental-strip-types --test e2e/wheel-gesture.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { classifyWheel, newWheelState, pinchFactor, wheelAction, wheelPixels, STICKY_MS, type WheelLike } from "../src/lib/wheel-gesture.ts";

const ev = (o: Partial<WheelLike>): WheelLike => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, ...o });
const kind = (o: Partial<WheelLike>, st = newWheelState(), t = 1000) => classifyWheel(ev(o), st, t);

test("mouse notches and line/page units are mouse", () => {
  assert.equal(kind({ deltaY: 100 }), "mouse");
  assert.equal(kind({ deltaY: -120 }), "mouse");
  assert.equal(kind({ deltaY: 200 }), "mouse");
  assert.equal(kind({ deltaY: 3, deltaMode: 1 }), "mouse");
  assert.equal(kind({ deltaY: 1, deltaMode: 2 }), "mouse");
});
test("fractional, small or horizontal deltas are touchpad", () => {
  assert.equal(kind({ deltaY: 4.5 }), "touchpad");
  assert.equal(kind({ deltaY: 8 }), "touchpad");
  assert.equal(kind({ deltaY: 0, deltaX: 12 }), "touchpad");
  assert.equal(kind({ deltaY: 100, deltaX: 3 }), "touchpad");
  assert.equal(kind({ deltaY: 100.5 }), "touchpad");
});
test("a touchpad fling ending in round numbers stays touchpad, a later wheel notch is mouse again", () => {
  const st = newWheelState();
  assert.equal(kind({ deltaY: 7.3 }, st, 1000), "touchpad");
  assert.equal(kind({ deltaY: 100 }, st, 1016), "touchpad");
  assert.equal(kind({ deltaY: 40 }, st, 1032), "touchpad");
  assert.equal(kind({ deltaY: 100 }, st, 1032 + STICKY_MS + 1), "mouse");
});
test("ambiguous integer follows the recent verdict, else magnitude", () => {
  const st = newWheelState();
  assert.equal(kind({ deltaY: 75 }, st, 1000), "mouse");
  assert.equal(kind({ deltaY: 30 }, st, 1010), "mouse");
  assert.equal(kind({ deltaY: 30 }, st, 5000), "touchpad");
});
test("actions per mode", () => {
  const act = (o: Partial<WheelLike>, mode: "auto" | "trackpad" | "mouse") => wheelAction(ev(o), mode, newWheelState(), 0);
  assert.equal(act({ deltaY: 5.5 }, "auto"), "pan");
  assert.equal(act({ deltaY: 100 }, "auto"), "zoom");
  assert.equal(act({ deltaY: 100 }, "trackpad"), "pan");
  assert.equal(act({ deltaY: 5.5 }, "mouse"), "zoom");
  assert.equal(act({ deltaY: 3.2, ctrlKey: true }, "auto"), "pinch");
  assert.equal(act({ deltaY: 3.2, ctrlKey: true }, "mouse"), "pinch");
  assert.equal(act({ deltaY: 100, ctrlKey: true }, "auto"), "zoom");
  assert.equal(act({ deltaY: 100, metaKey: true }, "trackpad"), "zoom");
});
test("pixels and pinch factor", () => {
  assert.deepEqual(wheelPixels(ev({ deltaX: 1, deltaY: 2, deltaMode: 1 })), { x: 16, y: 32 });
  assert.ok(pinchFactor(-5) > 1 && pinchFactor(5) < 1);
  assert.ok(Math.abs(pinchFactor(-2) - 1) < Math.abs(pinchFactor(-6) - 1));
  assert.equal(pinchFactor(-1000), pinchFactor(-60));
});
