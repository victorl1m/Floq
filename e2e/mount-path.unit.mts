// Run: node --experimental-strip-types --test e2e/mount-path.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { mountSegments } from "../src/lib/mount-path.ts";

test("single folder: any label maps to it", () => {
  assert.deepEqual(mountSegments(["app"], { label: "whatever", rel: "src/a b/ñ.txt" }), ["app", "src", "a b", "ñ.txt"]);
  assert.deepEqual(mountSegments(["app"], { label: "app", rel: "" }), ["app"]);
});
test("several folders: exact then case-insensitive, else root", () => {
  assert.deepEqual(mountSegments(["api", "web"], { label: "web", rel: "x" }), ["web", "x"]);
  assert.deepEqual(mountSegments(["api", "Web"], { label: "web", rel: "" }), ["Web"]);
  assert.deepEqual(mountSegments(["api", "web"], { label: "other", rel: "x" }), []);
});
test("no item or traversal gives the root", () => {
  assert.deepEqual(mountSegments(["a"], undefined), []);
  assert.deepEqual(mountSegments(["a"], { label: "a", rel: "../x" }), []);
});
