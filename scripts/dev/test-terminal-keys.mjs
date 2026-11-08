import test from "node:test";
import assert from "node:assert/strict";
import { keyToSequence, isControlKey } from "../../src/components/canvas/terminal-keys.ts";

const k = (key, mods = {}) => ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test("mode and navigation keys", () => {
  assert.equal(keyToSequence(k("Tab", { shiftKey: true })), "\x1b[Z");
  assert.equal(keyToSequence(k("Tab")), "\t");
  assert.equal(keyToSequence(k("Escape")), "\x1b");
  assert.equal(keyToSequence(k("ArrowUp")), "\x1b[A");
  assert.equal(keyToSequence(k("ArrowLeft", { ctrlKey: true })), "\x1b[1;5D");
  assert.equal(keyToSequence(k("Delete")), "\x1b[3~");
  assert.equal(keyToSequence(k("PageDown")), "\x1b[6~");
  assert.equal(keyToSequence(k("Enter")), "\r");
  assert.equal(keyToSequence(k("Enter", { shiftKey: true })), "\n");
  assert.equal(keyToSequence(k("Backspace")), "\x7f");
});

test("control, alt and printable characters", () => {
  assert.equal(keyToSequence(k("c", { ctrlKey: true })), "\x03");
  assert.equal(keyToSequence(k("o", { ctrlKey: true })), "\x0f");
  assert.equal(keyToSequence(k("b", { altKey: true })), "\x1bb");
  assert.equal(keyToSequence(k("a")), "a");
  assert.equal(keyToSequence(k("é")), "é");
  assert.equal(keyToSequence(k("c", { metaKey: true })), null);
  assert.equal(keyToSequence(k("Shift")), null);
});

test("the empty message bar only forwards control keys", () => {
  assert.equal(isControlKey(k("a")), false);
  assert.equal(isControlKey(k("Tab", { shiftKey: true })), true);
  assert.equal(isControlKey(k("Escape")), true);
  assert.equal(isControlKey(k("c", { ctrlKey: true })), true);
  assert.equal(isControlKey(k("d", { ctrlKey: true })), false, "Ctrl+D would end the session");
  assert.equal(isControlKey(k("Backspace")), false);
});
