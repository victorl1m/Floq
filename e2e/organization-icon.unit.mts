// Run: node --experimental-strip-types --test e2e/organization-icon.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { ORGANIZATION_PALETTE, organizationIconBackground, organizationPaletteIndex } from "../src/lib/organizations.ts";

test("same name always gets the same palette entry (case and padding ignored)", () => {
  assert.equal(organizationPaletteIndex("Acme Corp"), organizationPaletteIndex("Acme Corp"));
  assert.equal(organizationPaletteIndex("Acme Corp"), organizationPaletteIndex("  acme corp "));
  assert.equal(organizationIconBackground("Zoe"), organizationIconBackground("Zoe"));
});

test("index is always inside the palette, including empty and unicode names", () => {
  for (const n of ["", "?", "Zoé Personalizações", "日本", "a".repeat(500)]) {
    const i = organizationPaletteIndex(n);
    assert.ok(Number.isInteger(i) && i >= 0 && i < ORGANIZATION_PALETTE.length);
  }
});

test("different names spread over several palette entries", () => {
  const used = new Set(["Acme", "Zoe", "Floq", "Globex", "Initech", "Umbrella", "Hooli", "Stark", "Wayne", "Wonka"].map(organizationPaletteIndex));
  assert.ok(used.size >= 3);
});

test("background is a gradient over theme tokens only", () => {
  assert.match(organizationIconBackground("Acme"), /^linear-gradient\(135deg, var\(--[a-z-]+\), var\(--[a-z-]+\)\)$/);
});
