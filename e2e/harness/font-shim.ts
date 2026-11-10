// Sandbox-only: headless Chromium here has no system fonts and its lazy @font-face loading of the legacy
// `format("woff2-variations")` Geist faces errors out, so every glyph measures 0x0 and Playwright calls the text "hidden".
// Register the latin subsets explicitly under the app's family names so text lays out like in the real app.
const base = "/node_modules/@fontsource-variable";
const faces: Array<[string, string]> = [
  ["Geist Variable", `${base}/geist/files/geist-latin-wght-normal.woff2`],
  ["Geist Variable", `${base}/geist/files/geist-latin-ext-wght-normal.woff2`],
  ["Geist Mono Variable", `${base}/geist-mono/files/geist-mono-latin-wght-normal.woff2`],
];
await Promise.all(faces.map(async ([family, url]) => {
  try {
    const face = new FontFace(family, `url(${url})`, { weight: "100 900" });
    document.fonts.add(await face.load());
  } catch { /* fall back to whatever the browser has */ }
}));
