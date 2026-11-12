// Generates Floq's in-app cursor set (original artwork, no third-party assets).
//   node scripts/gen-cursors.mjs
// Writes src/assets/cursors/*.svg, src/styles/cursors-tokens.css and docs/redesign/cursors.md.
// Style: white fill, 1.25px near-black outline, soft offset shadow. Readable on light, dark/OLED and canvas.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INK = "#111114";
const RED = "#d92d20";
const SIZE = 32;

// --- part helpers -----------------------------------------------------------
const fill = (d) => ({ k: "fill", d });
const line = (d) => ({ k: "line", d });
const mark = (d, color = INK, w = 1.6) => ({ k: "mark", d, color, w });
const dot = (cx, cy, r) => ({ k: "dot", cx, cy, r });
const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const group = (t, parts) => ({ k: "g", t, parts });

const ARROW = "M6 3.5V23.5L10.6 19.3L13.7 26.3L17 24.8L13.9 17.9H20.2Z";
const arrow = () => fill(ARROW);
const badgeCircle = () => fill(circle(23, 23, 5.6));

const EW = "M3.5 16L9.5 10.5V14H22.5V10.5L28.5 16L22.5 21.5V18H9.5V21.5Z";
const HAND = "M11.2 6.4C11.2 5.1 12.2 4.1 13.5 4.1S15.8 5.1 15.8 6.4V12.6C16.3 12.2 16.9 12 17.5 12C18.4 12 19.1 12.4 19.5 13C20 12.7 20.5 12.5 21.1 12.5C22.1 12.5 22.9 13 23.3 13.8C23.7 13.6 24.1 13.5 24.6 13.5C25.9 13.5 26.8 14.5 26.8 15.8V21C26.8 24.9 24.3 27.8 20.4 27.8H17.6C15.4 27.8 13.9 27 12.7 25.4L8.2 19.4C7.6 18.6 7.8 17.6 8.6 17.1C9.4 16.6 10.4 16.8 11 17.5L11.2 17.8Z";
const OPEN = "M9.5 16.5V10.2C9.5 9.2 10.3 8.4 11.1 8.4S12.7 9.2 12.7 10.2V8.2C12.7 7.2 13.5 6.4 14.3 6.4S15.9 7.2 15.9 8.2V7.6C15.9 6.6 16.7 5.8 17.5 5.8S19.1 6.6 19.1 7.6V9.2C19.1 8.2 19.9 7.5 20.7 7.5S22.3 8.2 22.3 9.2V19C22.3 23 19.8 26 16 26C13 26 11.2 24.6 9.8 22.4L6.4 17.4C6 16.6 6.3 15.8 7 15.5C7.8 15.2 8.6 15.5 9.1 16.2Z";
const FIST = "M9 13.5C9 12.5 9.8 11.8 10.7 11.8C11.5 11.8 12.1 12.2 12.4 12.8C12.7 12 13.4 11.5 14.2 11.5C15 11.5 15.7 12 16 12.7C16.3 12 17 11.6 17.8 11.6C18.6 11.6 19.4 12.2 19.6 13C19.9 12.5 20.5 12.2 21.1 12.2C22.1 12.2 22.9 13 22.9 14V19.5C22.9 23.4 20.3 26 16.6 26C13.4 26 11.5 24.8 10.2 22.9L7.2 18.6C6.8 17.8 7 17 7.8 16.7C8.4 16.4 9 16.7 9 17.4Z";
const COLS = [fill("M3.5 16L8.5 11.5V14.2H12V17.8H8.5V20.5Z"), fill("M28.5 16L23.5 11.5V14.2H20V17.8H23.5V20.5Z"), fill("M14.4 6H17.6V26H14.4Z")];
const EDGE_E = [fill("M9.6 6H12.4V26H9.6Z"), fill("M27 16L20.5 10.5V14H14.6V18H20.5V21.5Z")];

// name -> { hot:[x,y], fb: native fallback keyword, note, parts }
export const CURSORS = {
  "default":      { hot: [6, 4],   fb: "default",     note: "Arrow", parts: [arrow()] },
  "pointer":      { hot: [13, 4],  fb: "pointer",     note: "Links, buttons, menu items", parts: [fill(HAND), mark("M19.5 13.2V17.4M23.3 14V17.4M15.8 12.8V15", INK, 1)] },
  "text":         { hot: [16, 16], fb: "text",        note: "Text fields, editors", parts: [line("M12 5.5H20M16 5.5V26.5M12 26.5H20")] },
  "grab":         { hot: [15, 14], fb: "grab",        note: "Canvas pane pan, draggable nodes", parts: [fill(OPEN)] },
  "grabbing":     { hot: [15, 14], fb: "grabbing",    note: "While panning or dragging", parts: [fill(FIST)] },
  "move":         { hot: [16, 16], fb: "move",        note: "Free move, edge updater", parts: [fill("M16 4L20.5 9H17.5V14.5H23V11.5L28 16L23 20.5V17.5H17.5V23H20.5L16 28L11.5 23H14.5V17.5H9V20.5L4 16L9 11.5V14.5H14.5V9H11.5Z")] },
  "resize-ew":    { hot: [16, 16], fb: "ew-resize",   note: "Horizontal resize", parts: [fill(EW)] },
  "resize-ns":    { hot: [16, 16], fb: "ns-resize",   note: "Vertical resize", parts: [group("rotate(90 16 16)", [fill(EW)])] },
  "resize-nwse":  { hot: [16, 16], fb: "nwse-resize", note: "Diagonal resize (top-left / bottom-right)", parts: [group("rotate(45 16 16)", [fill(EW)])] },
  "resize-nesw":  { hot: [16, 16], fb: "nesw-resize", note: "Diagonal resize (top-right / bottom-left)", parts: [group("rotate(-45 16 16)", [fill(EW)])] },
  "resize-col":   { hot: [16, 16], fb: "col-resize",  note: "Sidebar and column splitters", parts: COLS },
  "resize-row":   { hot: [16, 16], fb: "row-resize",  note: "Row splitters", parts: [group("rotate(90 16 16)", COLS)] },
  "resize-e":     { hot: [16, 16], fb: "e-resize",    note: "Splitter at its minimum (can only grow right)", parts: EDGE_E },
  "resize-w":     { hot: [16, 16], fb: "w-resize",    note: "Splitter at its maximum (can only shrink left)", parts: [group("translate(32 0) scale(-1 1)", EDGE_E)] },
  "crosshair":    { hot: [16, 16], fb: "crosshair",   note: "Precision pick, box select", parts: [line("M16 4.5V13M16 19V27.5M4.5 16H13M19 16H27.5")] },
  "connect":      { hot: [16, 16], fb: "crosshair",   note: "Wire drawing and link mode", parts: [line("M16 3.5V8.5M16 23.5V28.5M3.5 16H8.5M23.5 16H28.5"), line(circle(16, 16, 7)), dot(16, 16, 2)] },
  "add-note":     { hot: [6, 4],   fb: "copy",        note: "Add note", parts: [arrow(), fill("M17.6 16.6H27.4V28.4H17.6Z"), mark("M22.5 19.5V25.5M19.5 22.5H25.5")] },
  "zoom-in":      { hot: [13, 13], fb: "zoom-in",     note: "Zoom in", parts: [line("M18.5 18.5L27 27"), fill(circle(13, 13, 8)), mark("M13 9V17M9 13H17")] },
  "zoom-out":     { hot: [13, 13], fb: "zoom-out",    note: "Zoom out", parts: [line("M18.5 18.5L27 27"), fill(circle(13, 13, 8)), mark("M9 13H17")] },
  "not-allowed":  { hot: [16, 16], fb: "not-allowed", note: "Disabled or invalid target", parts: [fill(circle(16, 16, 10.5)), mark("M8.6 8.6L23.4 23.4", RED, 2.2)] },
  "wait":         { hot: [16, 16], fb: "wait",        note: "Blocking busy (static, no animation)", parts: [fill(circle(16, 16, 10.5)), mark("M16 9.5V16L20.5 19", INK, 1.8)] },
  "progress":     { hot: [6, 4],   fb: "progress",    note: "Busy but interactive (aria-busy)", parts: [arrow(), badgeCircle(), mark("M23 18.8A4.2 4.2 0 1 1 18.8 23", INK, 1.6)] },
  "help":         { hot: [6, 4],   fb: "help",        note: "Help / explanatory", parts: [arrow(), badgeCircle(), mark("M21 21.2A2 2 0 1 1 23.6 23C22.9 23.4 23 24 23 24.4", INK, 1.5), dot(23, 26.2, 0.9)] },
  "copy":         { hot: [6, 4],   fb: "copy",        note: "Copy / duplicate", parts: [arrow(), badgeCircle(), mark("M23 19.8V26.2M19.8 23H26.2")] },
  "context-menu": { hot: [6, 4],   fb: "context-menu", note: "Context menu available", parts: [arrow(), fill("M17.4 17.4H28.6V28.6H17.4Z"), mark("M19.8 21H26.2M19.8 23.2H26.2M19.8 25.4H24", INK, 1.2)] },
};

// --- svg rendering ----------------------------------------------------------
function shadow(p) {
  if (p.k === "g") return `<g transform="${p.t}">${p.parts.map(shadow).join("")}</g>`;
  if (p.k === "fill") return `<path d="${p.d}" fill="#000" stroke="#000" stroke-width="2.4" stroke-linejoin="round"/>`;
  if (p.k === "line") return `<path d="${p.d}" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (p.k === "dot") return `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r + 1}" fill="#000"/>`;
  return "";
}
function ink(p) {
  if (p.k === "g") return `<g transform="${p.t}">${p.parts.map(ink).join("")}</g>`;
  if (p.k === "fill") return `<path d="${p.d}" fill="#fff" stroke="${INK}" stroke-width="1.25" stroke-linejoin="round"/>`;
  if (p.k === "line") return `<path d="${p.d}" fill="none" stroke="${INK}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><path d="${p.d}" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (p.k === "mark") return `<path d="${p.d}" fill="none" stroke="${p.color}" stroke-width="${p.w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (p.k === "dot") return `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="${INK}" stroke="#fff" stroke-width="1"/>`;
  return "";
}
export function svg(c) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<g transform="translate(.7 1.1)" opacity=".24">${c.parts.map(shadow).join("")}</g>${c.parts.map(ink).join("")}</svg>\n`;
}

// --- outputs ----------------------------------------------------------------
const dir = join(root, "src/assets/cursors");
mkdirSync(dir, { recursive: true });
mkdirSync(join(root, "src/styles"), { recursive: true });
mkdirSync(join(root, "docs/redesign"), { recursive: true });

let vars = "";
let sys = "";
let table = "| Action | Variable | File | Hotspot | Fallback |\n|---|---|---|---|---|\n";
for (const [name, c] of Object.entries(CURSORS)) {
  writeFileSync(join(dir, `${name}.svg`), svg(c));
  vars += `    --cursor-${name}: url("../assets/cursors/${name}.svg") ${c.hot[0]} ${c.hot[1]}, ${c.fb};\n`;
  sys += `  --cursor-${name}: ${c.fb};\n`;
  table += `| ${c.note} | \`--cursor-${name}\` | \`src/assets/cursors/${name}.svg\` | ${c.hot[0]}, ${c.hot[1]} | \`${c.fb}\` |\n`;
}
sys += "  --cursor-none: none;\n";
writeFileSync(join(root, "src/styles/cursors-tokens.css"),
`/* GENERATED by scripts/gen-cursors.mjs. Do not edit by hand.
   Custom cursors apply only inside the app web view (CSS cursor), never OS-wide.
   Every variable resolves to the native keyword when custom cursors are off:
   html[data-cursors="system"], forced-colors, or coarse/touch pointers. */
:root {
${sys}}
@media (pointer: fine) and (not (forced-colors: active)) {
  :root:not([data-cursors="system"]) {
${vars}  }
}
`);
writeFileSync(join(root, "docs/redesign/cursors.md"),
`# Floq in-app cursor set

Original artwork (white fill, 1.25px near-black outline, soft shadow), 32x32 SVG, drawn in-house by \`scripts/gen-cursors.mjs\` (single source of truth for SVGs, hotspots, CSS variables and this table). No third-party assets, so no licence file is required.
Scope: CSS \`cursor\` inside the app web view only. Setting: Settings > Appearance > Custom cursors (\`data-cursors="custom|system"\` on \`<html>\`).
Falls back to native cursors under forced-colors and coarse pointers. Terminals (xterm) keep native cursors.

${table}
\`--cursor-none\` is \`none\` (reserved for pointer-lock style cases; unused today).

## Tailwind mapping
\`@utility\` overrides in \`src/styles/cursors.css\` remap \`cursor-default|pointer|text|move|grab|grabbing|crosshair|not-allowed|wait|progress|help|copy|context-menu|zoom-in|zoom-out|col-resize|row-resize|ew-resize|ns-resize|nesw-resize|nwse-resize|e-resize|w-resize|none\` plus new \`cursor-connect|add-note\` to the variables; variants (active:, disabled:, hover:) keep working.

## State hooks
- \`.react-flow__pane\` grab / dragging grabbing / selection crosshair; nodes grab; handles connect; resizers per direction.
- \`[data-canvas-tool="link|select|pan"]\` on the canvas wrapper: link mode -> connect, select -> crosshair.
- \`html[data-dnd-dragging]\` (sidebar drag and drop) and \`html[data-sidebar-resizing]\` force grabbing / col-resize everywhere.
- \`[aria-busy="true"]\` buttons/status -> progress; disabled -> not-allowed.
`);
console.log(`wrote ${Object.keys(CURSORS).length} cursors`);
