// Run: node --experimental-strip-types --test e2e/org-icon.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { ORG_ICON_MOTIFS, ORG_ICON_PALETTE, orgIconSpec, orgIconSvg, orgMonogram } from "../src/lib/org-icon.ts";

const UUID = "3f2b8c1e-5d4a-4b7e-9c10-2a6d8e4f7b13";

test("same seed gives identical svg and spec; case and padding are ignored", () => {
  assert.equal(orgIconSvg("acme"), orgIconSvg("acme"));
  assert.deepEqual(orgIconSpec("acme"), orgIconSpec("  ACME "));
  assert.equal(orgIconSvg("acme"), orgIconSvg("  Acme "));
});

test("empty, unicode and very long seeds work", () => {
  for (const s of ["", "   ", "Zoé Personalizações", "日本", "🚀", "a".repeat(500)]) {
    const spec = orgIconSpec(s);
    assert.ok(ORG_ICON_PALETTE.some((p) => p.color === spec.color));
    assert.ok(orgIconSvg(s).startsWith("<svg"));
  }
});

test("every spec value is inside its table", () => {
  for (let i = 0; i < 100; i++) {
    const spec = orgIconSpec(`seed-${i}`);
    assert.ok(ORG_ICON_PALETTE.some((p) => p.color === spec.color && p.name === spec.colorName));
    assert.ok(ORG_ICON_MOTIFS.some((m) => m.name === spec.motif));
    assert.ok([0, 90, 180, 270].includes(spec.turn));
  }
});

test("200 seeds use every colour, every motif and at least 3 turns", () => {
  const specs = Array.from({ length: 200 }, (_, i) => orgIconSpec(`org-${i}-${i * 7919}`));
  assert.equal(new Set(specs.map((s) => s.color)).size, ORG_ICON_PALETTE.length);
  assert.equal(new Set(specs.map((s) => s.motif)).size, ORG_ICON_MOTIFS.length);
  assert.ok(new Set(specs.map((s) => s.turn)).size >= 3);
});

test("white text has WCAG contrast >= 4.5 on every palette colour", () => {
  const lin = (v: number) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  for (const { name, color } of ORG_ICON_PALETTE) {
    const ratio = 1.05 / (lum(color) + 0.05);
    assert.ok(ratio >= 4.5, `${name} ${color} contrast ${ratio.toFixed(2)}`);
  }
});

test("orgMonogram", () => {
  assert.equal(orgMonogram("Zoé Personalizações"), "ZP");
  assert.equal(orgMonogram("日本"), "日");
  assert.equal(orgMonogram("acme"), "A");
  assert.equal(orgMonogram("  "), "");
  assert.equal(orgMonogram("🚀 Rocket Labs"), "RL");
  assert.equal(orgMonogram("Rocket Labs Inc", 1), "R");
  assert.equal(orgMonogram("Rocket Labs Inc"), "RL");
  assert.equal(orgMonogram("---"), "");
});

test("monogram sizing, weight and escaping", () => {
  const one = orgIconSvg(UUID, { monogram: "Z" });
  const two = orgIconSvg(UUID, { monogram: "ZP" });
  assert.match(one, /font-size="36"/);
  assert.match(two, /font-size="27"/);
  assert.match(two, /font-weight="700"/);
  assert.doesNotMatch(two, /font-family/);
  assert.match(orgIconSvg(UUID, { monogram: "ZPQ" }), />ZP<\/text>/);
  const evil = orgIconSvg(UUID, { monogram: '<&"' });
  assert.ok(evil.includes(">&lt;&amp;</text>"));
  assert.ok(orgIconSvg(UUID, { monogram: '"\'' }).includes("&quot;&#39;"));
  assert.ok(!evil.includes("<&"));
  assert.ok(!evil.includes('<script'));
});

test("no monogram means no text; svg is self-contained", () => {
  assert.ok(!orgIconSvg(UUID).includes("<text"));
  assert.ok(!orgIconSvg(UUID, { monogram: "" }).includes("<text"));
  for (const s of ["acme", "floq", UUID]) {
    const svg = orgIconSvg(s, { monogram: "AB" });
    assert.ok(svg.includes('viewBox="0 0 64 64"'));
    for (const bad of ["id=", "<script", "href"]) assert.ok(!svg.includes(bad), bad);
  }
});

// Golden specs: a change here means EXISTING organizations change their icon. Only append to the tables, never reorder.
test("golden specs", () => {
  assert.deepEqual(orgIconSpec("acme"), { color: "#0F6E78", colorName: "teal", motif: "floors", turn: 0 });
  assert.deepEqual(orgIconSpec("floq"), { color: "#8A5412", colorName: "clay", motif: "floors", turn: 270 });
  assert.deepEqual(orgIconSpec(UUID), { color: "#1D5FC4", colorName: "blue", motif: "fold", turn: 270 });
});
