// Run: node --experimental-strip-types --test e2e/settings-index.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { SETTINGS_INDEX, searchSettings } from "../src/lib/settings-index.ts";

const DIR = "src/components/settings/";
const files = readdirSync(DIR).filter((f) => f.endsWith(".tsx")).map((f) => [f, readFileSync(DIR + f, "utf8")] as const);
const ROW_IDS = new Set(SETTINGS_INDEX.filter((e) => e.id).map((e) => e.id!));
const LABELS = new Set(SETTINGS_INDEX.map((e) => e.label));
/** Literal row labels that are status, per-item or admin-only detail and deliberately not searchable. */
const UNINDEXED = new Set(["Account name", "Email", "Website", "App version", "Runtime version", "Status", "Sites with cookies", "Connection", "If this computer is offline", "Your role", "Transfer ownership", "Delete organization", "Leave organization", "URL name", "Server", "Version", "Started", "Active sessions"]);
const ALL = { admin: true, desktopWindows: true };
const top = (q: string, vis = ALL) => searchSettings(q, vis).map((e) => e.id ?? e.section);

test("every literal SettingRow label is indexed or explicitly exempt", () => {
    const missing: string[] = [];
    for (const [file, src] of files) {
        for (const m of src.matchAll(/<SettingRow\b([^>]|=>)*?\blabel="([^"]+)"/gs)) {
            const label = m[2]!;
            if (!LABELS.has(label) && !UNINDEXED.has(label)) missing.push(`${file}: ${label}`);
        }
    }
    assert.deepEqual(missing, []);
});

test("every indexed row id is declared by a SettingRow, and its label is the real one", () => {
    const source = files.map(([, s]) => s).join("\n");
    for (const e of SETTINGS_INDEX.filter((x) => x.id)) {
        assert.ok(new RegExp(`settingId="${e.id}"`).test(source), `no SettingRow declares settingId="${e.id}"`);
        assert.ok(source.includes(`label="${e.label}"`), `label "${e.label}" not found in settings sources`);
    }
    for (const [, s] of files) for (const m of s.matchAll(/settingId="([^"]+)"/g)) assert.ok(ROW_IDS.has(m[1]!), `settingId ${m[1]} missing from the index`);
});

test("every section of the dialog has an entry", () => {
    const dialog = readFileSync(DIR + "settings-dialog.tsx", "utf8");
    const ids = [...dialog.matchAll(/\{ id: "([a-z]+)", label: "/g)].map((m) => m[1]);
    assert.ok(ids.length >= 14);
    for (const id of ids) assert.ok(SETTINGS_INDEX.some((e) => !e.id && e.section === id), `section ${id}`);
});

test("ranking: synonyms find the right row first", () => {
    assert.equal(top("proxy")[0], "browser-egress");
    assert.equal(top("ip")[0], "browser-egress");
    assert.equal(top("avatar")[0], "appearance-robot-avatars");
    assert.equal(top("active agents")[0], "agents-active");
    assert.equal(top("fallback")[0], "accounts-fallback");
    assert.equal(top("acrylic")[0], "appearance-material");
    assert.equal(top("import cookies")[0], "browser-import");
    assert.equal(top("auto-approve").slice(0, 2).sort().join(), "agents-claude-auto-approve,agents-codex-auto-approve");
    assert.equal(top("connectors")[0], "accounts-connectors");
});

test("ranking: 'settings' and section names list sections", () => {
    const all = searchSettings("settings", ALL, 50);
    assert.ok(all.length >= 13 && all.every((e) => !e.id));
    assert.equal(top("browser")[0], "browser");
    assert.equal(top("appearance")[0], "appearance");
    assert.equal(top("settings browser")[0], "browser");
    assert.equal(top("zzzz").length, 0);
    assert.equal(top("").length, 0);
});

test("visibility: Users is admin only, Desktop needs the Windows desktop app", () => {
    assert.ok(!top("users", { admin: false, desktopWindows: false }).includes("users"));
    assert.ok(top("users", ALL).includes("users"));
    assert.ok(!top("desktop", { admin: true, desktopWindows: false }).includes("desktop"));
    assert.ok(top("desktop", ALL).includes("desktop"));
});
