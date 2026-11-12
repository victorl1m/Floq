/**
 * Floq agent avatars: flat, seeded "blob with eyes" marks drawn as inline SVG (no network, no dependency).
 * Same seed (the immutable Floq session UUID) => same avatar forever, so never reorder the tables below;
 * only append. Geometry lives in a 64-unit box and keeps every eye at least 6 units thick, so it reads at 16 px.
 */

/** Floq orange first, then hues that sit next to it on both themes and keep white eyes legible. */
export const AVATAR_PALETTE = [
    "#FF8A08", // Floq orange (icon core)
    "#F4511E", // ember (icon under-fold)
    "#E8457C", // rose
    "#9B5DE5", // violet
    "#4F6BED", // indigo
    "#1E96E8", // sky
    "#0FA69A", // teal
    "#2FB35A", // leaf
    "#B5793A", // clay
    "#5B6170", // graphite
] as const;

type Shape = {
    name: string;
    /** SVG body markup with `F` as the fill placeholder. */
    body: string;
    /** Eye centre (between both eyes) and half the eye spacing. */
    eye: [number, number, number];
    /** Optional specular highlight: centre, rotation. */
    shine?: [number, number, number];
};

/** Rounded polygons use a same-colour round-joined stroke: soft corners, same family as the Floq wave's curves. */
const round = (points: string, w = 10) => `<polygon points="${points}" fill="F" stroke="F" stroke-width="${w}" stroke-linejoin="round"/>`;

export const AVATAR_SHAPES: Shape[] = [
    { name: "orb", body: `<circle cx="32" cy="32" r="25" fill="F"/>`, eye: [29, 27, 7], shine: [19, 18, -40] },
    { name: "drop", body: `<path d="M38 6.5c3.2-1.6 6.5.6 6.9 3.9.9 7.4 4.3 12 8 17.6A23 23 0 1 1 13.9 23c5.1-6.7 15.4-13.5 24.1-16.5Z" fill="F"/>`, eye: [28, 30, 7], shine: [21, 27, -50] },
    { name: "peak", body: round("32,13 54,51 10,51"), eye: [27, 33, 5.5] },
    { name: "cloud", body: `<g fill="F"><circle cx="22" cy="37" r="14"/><circle cx="35" cy="25" r="16"/><circle cx="46" cy="38" r="13"/><circle cx="31" cy="44" r="13"/></g>`, eye: [29, 28, 7] },
    { name: "pill", body: `<rect x="5" y="15" width="54" height="34" rx="17" fill="F"/>`, eye: [29, 28, 8], shine: [15, 25, -60] },
    { name: "clover", body: `<g fill="F"><circle cx="32" cy="18" r="13"/><circle cx="46" cy="32" r="13"/><circle cx="32" cy="46" r="13"/><circle cx="18" cy="32" r="13"/><circle cx="32" cy="32" r="14"/></g>`, eye: [29, 28, 6.5] },
    { name: "tile", body: `<rect x="9" y="9" width="46" height="46" rx="17" fill="F"/>`, eye: [29, 28, 7.5], shine: [18, 19, -45] },
    // A nod to the Floq wave: dome on top, a soft wave along the hem.
    { name: "wave", body: `<path d="M9 31a23 23 0 0 1 46 0v19c0 4-4.8 6.2-7.8 3.6l-.9-.8a5.3 5.3 0 0 0-7 0l-.8.7a5.3 5.3 0 0 1-7 0l-.8-.7a5.3 5.3 0 0 0-7 0l-.8.7a5.3 5.3 0 0 1-7 0l-.4-.3C13.8 56.2 9 54 9 50Z" fill="F"/>`, eye: [29, 28, 7], shine: [19, 20, -40] },
    { name: "bean", body: `<path d="M14 18c7-9 22-9 32-4 10 5 13 18 9 28-5 12-20 16-31 12C11 50 6 31 14 18Z" fill="F"/>`, eye: [29, 28, 7] },
];

type Eyes = (x: number, y: number) => string;
const pill = (x: number, y: number, w: number, h: number, rot = 0) =>
    `<rect data-eye="" x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${Math.min(w, h) / 2}" fill="#fff"${rot ? ` transform="rotate(${rot} ${x} ${y})"` : ""}/>`;

export const AVATAR_EYES: { name: string; draw: (gap: number) => Eyes }[] = [
    { name: "pills", draw: (g) => (x, y) => pill(x - g, y, 6.5, 13) + pill(x + g, y, 6.5, 13) },
    { name: "tilted", draw: (g) => (x, y) => pill(x - g, y, 6.5, 13, 20) + pill(x + g, y, 6.5, 13, 20) },
    { name: "dashes", draw: (g) => (x, y) => pill(x - g - 1, y, 12, 6, 18) + pill(x + g + 1, y + 1, 12, 6, 24) },
    { name: "beads", draw: (g) => (x, y) => `<circle data-eye="" cx="${x - g}" cy="${y}" r="4.6" fill="#fff"/><circle data-eye="" cx="${x + g}" cy="${y}" r="4.6" fill="#fff"/>` },
    { name: "wide", draw: (g) => (x, y) => pill(x - g, y, 9, 12) + pill(x + g, y, 9, 12) },
    { name: "sleepy", draw: (g) => (x, y) => pill(x - g, y + 2, 10, 6) + pill(x + g, y + 2, 10, 6) },
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

export type AvatarSpec = { color: string; shape: string; eyes: string; rotate: number; shine: boolean };

export function avatarSpec(seed: string): AvatarSpec {
    const next = stream(seed);
    const color = AVATAR_PALETTE[next(AVATAR_PALETTE.length)];
    const shape = AVATAR_SHAPES[next(AVATAR_SHAPES.length)];
    const eyes = AVATAR_EYES[next(AVATAR_EYES.length)];
    const rotate = next(15) - 7; // -7..7 degrees
    const shine = !!shape.shine && next(3) === 0;
    return { color, shape: shape.name, eyes: eyes.name, rotate, shine };
}

const svgCache = new Map<string, string>();

/**
 * SVG markup for `seed`. `detail` adds the specular highlight; callers turn it off below 24 px so nothing
 * hairline-thin appears in small rows.
 */
export function robotAvatarSvg(seed: string, detail = true): string {
    const key = `${detail ? 1 : 0}${seed}`;
    const hit = svgCache.get(key);
    if (hit) return hit;
    const spec = avatarSpec(seed);
    const shape = AVATAR_SHAPES.find((s) => s.name === spec.shape)!;
    const eyes = AVATAR_EYES.find((e) => e.name === spec.eyes)!;
    const [ex, ey, gap] = shape.eye;
    const shine = detail && spec.shine && shape.shine
        ? `<rect x="${shape.shine[0] - 2.75}" y="${shape.shine[1] - 6}" width="5.5" height="12" rx="2.75" fill="#fff" opacity=".42" transform="rotate(${shape.shine[2]} ${shape.shine[0]} ${shape.shine[1]})"/>`
        : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true" data-avatar-shape="${spec.shape}" data-avatar-eyes="${spec.eyes}" data-avatar-color="${spec.color}">`
        + `<g transform="rotate(${spec.rotate} 32 32)">${shape.body.split('"F"').join(`"${spec.color}"`)}${shine}${eyes.draw(gap)(ex, ey)}</g></svg>`;
    svgCache.set(key, svg);
    return svg;
}
