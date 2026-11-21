import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { packageVersion } from "../dist/config.js";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")).version as string;

test("the runtime reports its package.json version (not a hard-coded fallback)", () => {
    assert.equal(packageVersion(), read("../package.json"));
});

// Updates compare this version with the latest GitHub release tag (the app version). If they drift, Settings shows
// "Installed 0.2.0 / latest 1.0.43" with a bogus Update button forever.
test("runtime/package.json version equals the app version on every release", () => {
    assert.equal(read("../package.json"), read("../../package.json"));
    assert.equal(read("../package.json"), read("../../src-tauri/tauri.conf.json"));
});
