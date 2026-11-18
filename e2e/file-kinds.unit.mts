// Run: node --experimental-strip-types --test e2e/file-kinds.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { docKindForPath, IMAGE_EXT, needsTranscode, transcodeUrl } from "../src/lib/file-kinds.ts";
import { markdownToHtml } from "../src/lib/markdown-lite.ts";

test("kind mapping", () => {
  for (const e of ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]) assert.equal(docKindForPath(`a/b.${e}`), "audio");
  for (const e of ["mp4", "webm", "mov", "m4v", "ogv"]) assert.equal(docKindForPath(`x.${e.toUpperCase()}`), "video");
  for (const e of ["xlsx", "xls", "csv", "tsv", "ods"]) assert.equal(docKindForPath(`s.${e}`), "sheet");
  assert.equal(docKindForPath("r.md"), "markdown");
  assert.equal(docKindForPath("d.json"), "json");
  assert.equal(docKindForPath("p.html"), "html");
  assert.equal(docKindForPath("p.pptx"), "nopreview");
  assert.equal(docKindForPath("a.ts"), null);
  assert.equal(docKindForPath("noext"), null);
});
test("formats the webview cannot decode are media that needs conversion", () => {
  for (const e of ["wmv", "avi", "mkv", "flv", "mpg", "mpeg", "3gp", "m2ts"]) { assert.equal(docKindForPath(`v.${e}`), "video"); assert.ok(needsTranscode(`v.${e.toUpperCase()}`)); }
  for (const e of ["wma", "aiff", "aif", "ac3", "amr"]) { assert.equal(docKindForPath(`a.${e}`), "audio"); assert.ok(needsTranscode(`a.${e}`)); }
  for (const e of ["mp4", "mov", "webm", "m4a", "mp3"]) assert.ok(!needsTranscode(`x.${e}`), "played directly first");
  assert.ok(!needsTranscode("src/index.ts") && docKindForPath("src/index.ts") === null, ".ts stays TypeScript");
  assert.equal(transcodeUrl("/v1/x?t=abc"), "/v1/x?t=abc&transcode=1");
  assert.equal(transcodeUrl("/v1/x"), "/v1/x?transcode=1");
});
test("image extensions", () => {
  for (const e of ["svg", "bmp", "avif", "ico", "png"]) assert.ok(IMAGE_EXT.test(`i.${e}`));
  assert.ok(!IMAGE_EXT.test("i.mp3"));
});
test("markdown escapes html and limits links", () => {
  const h = markdownToHtml("# T\n\n<script>x</script> [a](javascript:alert(1)) [b](https://e.com)\n\n- one\n- **two**");
  assert.ok(!h.includes("<script>"));
  assert.ok(!h.includes('href="javascript'));
  assert.ok(h.includes('href="https://e.com"'));
  assert.ok(h.includes("<h1>T</h1>") && h.includes("<strong>two</strong>"));
});
