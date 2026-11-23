// Every command the desktop app registers must be allowed for some window, or calling it fails with
// "Command <name> not allowed by ACL" (download_with_picker shipped registered but not allowed).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const perms = readFileSync(new URL("../src-tauri/permissions/island.toml", import.meta.url), "utf8");

test("every registered Tauri command is allowed by a permission", () => {
  const handler = lib.match(/generate_handler!\[([\s\S]*?)\]/);
  assert.ok(handler, "generate_handler! not found");
  const registered = handler[1].split(",").map((s) => s.trim().split("::").pop()).filter(Boolean);
  const allowed = new Set([...perms.matchAll(/commands\.allow\s*=\s*\[([\s\S]*?)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])));
  const missing = registered.filter((c) => !allowed.has(c));
  assert.deepEqual(missing, [], "registered but not allowed: " + missing.join(", "));
});
