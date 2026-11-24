// Run: node --experimental-strip-types --test e2e/markdown-lite.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml } from "../src/lib/markdown-lite.ts";

test("a GFM table renders as a table: header, alignment, inline marks, escaped pipes, outer pipes optional", () => {
  const md = "Intro line\n| O quê | Número | Nota |\n|---|---:|:---:|\n| Seguidores | **517** | base \\| local |\nCidade | 62% | ok\n\nAfter";
  const html = markdownToHtml(md);
  assert.match(html, /<p>Intro line<\/p>/);
  assert.match(html, /<thead><tr><th>O quê<\/th><th style="text-align:right">Número<\/th><th style="text-align:center">Nota<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>Seguidores<\/td><td style="text-align:right"><strong>517<\/strong><\/td><td style="text-align:center">base \| local<\/td>/);
  assert.match(html, /<td>Cidade<\/td>/);
  assert.match(html, /<p>After<\/p>/);
  assert.doesNotMatch(html, /\|---/);
});

test("a line with a pipe but no separator row stays a paragraph; strikethrough renders; HTML stays escaped", () => {
  const html = markdownToHtml("a | b\n\n~~old~~ <b>x</b>");
  assert.match(html, /<p>a \| b<\/p>/);
  assert.match(html, /<del>old<\/del> &lt;b&gt;x&lt;\/b&gt;/);
});
