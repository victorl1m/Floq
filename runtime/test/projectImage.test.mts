import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedProjectImage, MAX_PROJECT_IMAGE_BYTES } from "../dist/projectImage.js";

test("project images accept safe direct URLs and bounded normalized WebP thumbnails", () => {
  assert.equal(isAllowedProjectImage("https://example.test/icon.png"), true);
  assert.equal(isAllowedProjectImage("http://example.test/favicon.ico"), true);
  assert.equal(isAllowedProjectImage("https://user:secret@example.test/icon.png"), false);
  assert.equal(isAllowedProjectImage("javascript:alert(1)"), false);

  const bytes = Buffer.alloc(20);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WEBP", 8, "ascii");
  const image = `data:image/webp;base64,${bytes.toString("base64")}`;
  assert.equal(isAllowedProjectImage(image), true);
  assert.equal(isAllowedProjectImage(image.replace("image/webp", "image/png")), false);
  assert.equal(isAllowedProjectImage(`data:image/webp;base64,${Buffer.from("not-webp").toString("base64")}`), false);
});

test("embedded project thumbnails are strictly capped and canonical base64", () => {
  const oversized = Buffer.alloc(MAX_PROJECT_IMAGE_BYTES + 1);
  oversized.write("RIFF", 0, "ascii");
  oversized.write("WEBP", 8, "ascii");
  assert.equal(isAllowedProjectImage(`data:image/webp;base64,${oversized.toString("base64")}`), false);
  assert.equal(isAllowedProjectImage("data:image/webp;base64,AAAA!"), false);
});
