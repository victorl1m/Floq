/**
 * Generated organization icons: a flat "signboard" tile (solid colour, one translucent geometric motif, optional monogram)
 * drawn as inline SVG (no network, no dependency). Same seed (the organization id) => same icon forever, so never reorder
 * the tables below; only append. Motifs live in a 64-unit box.
 */

/** Every colour gives white text a contrast of at least 4.5:1. */
export const ORG_ICON_PALETTE = [
    { name: "ember", color: "#C2410C" },
    { name: "rose", color: "#BE185D" },
    { name: "violet", color: "#7C3AED" },
    { name: "indigo", color: "#4338CA" },
    { name: "blue", color: "#1D5FC4" },
    { name: "teal", color: "#0F6E78" },
    { name: "green", color: "#15703A" },
    { name: "clay", color: "#8A5412" },
    { name: "plum", color: "#86198F" },
    { name: "graphite", color: "#475066" },
] as const;

const L = 'fill="#fff" fill-opacity=".16"';
const D = 'fill="#000" fill-opacity=".18"';

export const ORG_ICON_MOTIFS: { name: string; body: string }[] = [
    { name: "quarter", body: `<circle cx="0" cy="64" r="44" ${L}/>` },
    { name: "split", body: `<path d="M0 64 64 0V64Z" ${D}/>` },
    { name: "arch", body: `<circle cx="32" cy="64" r="34" ${L}/><circle cx="32" cy="64" r="18" ${D}/>` },
    { name: "floors", body: `<rect x="0" y="34" width="64" height="10" ${L}/><rect x="0" y="44" width="64" height="10" fill="#fff" fill-opacity=".09"/><rect x="0" y="54" width="64" height="10" ${D}/>` },
    { name: "checker", body: `<rect x="32" y="0" width="32" height="32" ${L}/><rect x="0" y="32" width="32" height="32" ${D}/>` },
    { name: "rings", body: `<circle cx="64" cy="0" r="48" ${L}/><circle cx="64" cy="0" r="28" ${D}/>` },
    { name: "steps", body: `<path d="M0 64V44H20V28H42V12H64V64Z" ${D}/>` },
    { name: "fold", body: `<path d="M30 0H64V34Z" ${L}/><path d="M0 30V64H34Z" ${D}/>` },
];

/** FNV-1a then a small xorshift stream: stable across platforms and JS engines. */
function stream(seed: string) {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
    let s = h >>> 0 || 1;
    return (n: number) => {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        return s % n;
    };
}

/** First letter or digit of each word of `name` (up to `max`), upper-cased. "" when there is none. */
export function orgMonogram(name: string, max: 1 | 2 = 2): string {
    const out: string[] = [];
    for (const part of name.split(/[\s@._\-/&+]+/u)) {
        for (const ch of Array.from(part)) {
            if (/[\p{L}\p{N}]/u.test(ch)) { out.push(ch); break; }
        }
        if (out.length >= max) break;
    }
    return out.slice(0, max).join("").toLocaleUpperCase();
}

export type OrgIconSpec = { color: string; colorName: string; motif: string; turn: 0 | 90 | 180 | 270 };

export function orgIconSpec(seed: string): OrgIconSpec {
    const key = seed.trim().toLowerCase() || "?";
    const next = stream(key);
    const colour = ORG_ICON_PALETTE[next(ORG_ICON_PALETTE.length)];
    const motif = ORG_ICON_MOTIFS[next(ORG_ICON_MOTIFS.length)];
    const turn = (next(4) * 90) as OrgIconSpec["turn"];
    return { color: colour.color, colorName: colour.name, motif: motif.name, turn };
}

const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const svgCache = new Map<string, string>();

/** SVG markup for `seed`; the optional monogram is drawn in white over the motif. Output is safe for dangerouslySetInnerHTML. */
export function orgIconSvg(seed: string, opts?: { monogram?: string }): string {
    const letters = Array.from(opts?.monogram ?? "").slice(0, 2);
    const mono = letters.join("");
    const key = `${mono}\u0000${seed}`;
    const hit = svgCache.get(key);
    if (hit) return hit;
    const spec = orgIconSpec(seed);
    const motif = ORG_ICON_MOTIFS.find((m) => m.name === spec.motif)!;
    const turn = spec.turn ? ` transform="rotate(${spec.turn} 32 32)"` : "";
    const text = letters.length
        ? `<text x="32" y="32" dy=".36em" text-anchor="middle" fill="#fff" font-weight="700" font-size="${letters.length === 1 ? 36 : 27}" letter-spacing="${letters.length === 1 ? "0" : "-.5"}">${escapeXml(mono)}</text>`
        : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%" style="display:block;width:100%;height:100%" aria-hidden="true" data-org-color="${spec.colorName}" data-org-motif="${spec.motif}" data-org-turn="${spec.turn}">`
        + `<rect width="64" height="64" fill="${spec.color}"/><g${turn}>${motif.body}</g>${text}</svg>`;
    svgCache.set(key, svg);
    return svg;
}
