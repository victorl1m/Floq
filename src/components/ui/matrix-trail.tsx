import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

// Original "matrix trail": a persistent, dim ambient field of monospace glyphs
// with a pointer trail that lights cells up and decays back to the ambient
// level. The trail reacts only while the pointer is over the background: the
// parent itself or an element marked `data-matrix-bg`. Anything else (cards,
// text, controls) is foreground and spawns nothing.
//
// Cost model: the static field is rendered once to an offscreen canvas and
// blitted per frame; ~30fps while only ambient twinkle runs, full rate only
// while trail glyphs are alive; paused when hidden or off-screen.

const GLYPHS = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEFXZ<>=+*";
const MAX_GLYPHS = 160;
const MAX_TWINKLE = 48;
const CELL_COOLDOWN_MS = 140;
const AMBIENT_FRAME_MS = 33;

type Rgb = [number, number, number];
type Glyph = { cell: number; x: number; y: number; ch: string; born: number };
type Twinkle = { cell: number; ch: string; start: number; dur: number };
type Palette = { dark: boolean; body: Rgb; head: Rgb };

export type MatrixTrailProps = {
    className?: string;
    /** Any CSS colour or var(--token) for the trail body. Defaults to theme tokens. */
    color?: string;
    fontSize?: number;
    /** Lifetime of a trail glyph in ms. */
    fadeMs?: number;
    /** 0..1 chance that a crossed cell spawns a trail glyph. */
    density?: number;
    /** Persistent dim glyph field behind the trail. Default true. */
    ambient?: boolean;
    /** Peak alpha of the ambient field (0.02-0.26). Default: 0.22 on dark, 0.16 on light.
     *  Text sits in `data-matrix-quiet` zones where the field is attenuated so it stays >= 4.5:1. */
    ambientOpacity?: number;
};

let probe: CanvasRenderingContext2D | null = null;
/** Resolve any CSS colour (hex, oklch, ...) to sRGB via a 1px canvas. */
function toRgb(css: string, fallback: Rgb): Rgb {
    try {
        probe ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
        if (!probe || !css.trim()) return fallback;
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = "#000";
        probe.fillStyle = css;
        probe.fillRect(0, 0, 1, 1);
        const d = probe.getImageData(0, 0, 1, 1).data;
        return d[3] ? [d[0], d[1], d[2]] : fallback;
    } catch {
        return fallback;
    }
}

function luminance([r, g, b]: Rgb) {
    const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function readPalette(el: HTMLElement, color?: string): Palette {
    const cs = getComputedStyle(el);
    const root = document.documentElement;
    const bg = toRgb(cs.getPropertyValue("--background"), [255, 255, 255]);
    const dark = root.classList.contains("dark") || root.dataset.theme === "dark" || luminance(bg) < 0.25;
    const fg = toRgb(cs.getPropertyValue("--foreground"), dark ? [245, 245, 247] : [32, 38, 51]);
    const primary = toRgb(color ?? cs.getPropertyValue("--primary"), [249, 115, 22]);
    if (dark) {
        // Light glyphs on dark / OLED: tinted foreground body, near-white head.
        const mix = (a: number, b: number) => Math.round(a * 0.65 + b * 0.35);
        return { dark, body: [mix(fg[0], primary[0]), mix(fg[1], primary[1]), mix(fg[2], primary[2])], head: [255, 255, 255] };
    }
    // Light: dark ink (foreground leaning to the accent), never white-on-white.
    const mix = (a: number, b: number) => Math.round(a * 0.55 + b * 0.45 * 0.6);
    return { dark, body: [mix(fg[0], primary[0] * 0.7), mix(fg[1], primary[1] * 0.7), mix(fg[2], primary[2] * 0.7)], head: [fg[0], fg[1], fg[2]] };
}

const rnd = (n: number) => (Math.random() * n) | 0;
// Cheap deterministic hash so the static field is stable across redraws.
const hash = (n: number) => { n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d); n = Math.imul(n ^ (n >>> 12), 0x297a2d39); return ((n ^ (n >>> 15)) >>> 0) / 4294967296; };

export function MatrixTrail({ className, color, fontSize = 13, fadeMs = 800, density = 1, ambient = true, ambientOpacity }: MatrixTrailProps) {
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = ref.current;
        const parent = canvas?.parentElement;
        if (!canvas || !parent) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
        let reduced = motion.matches;
        if (reduced && !ambient) return;

        const cw = Math.round(fontSize * 0.95);
        const ch = Math.round(fontSize * 1.35);
        const font = `${fontSize}px "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
        let palette = readPalette(parent, color);
        const ambFor = (dark: boolean) => Math.min(0.26, Math.max(0.02, ambientOpacity ?? (dark ? 0.22 : 0.16)));
        let ambMax = ambFor(palette.dark);
        let width = 0, height = 0, cols = 1, rows = 1, dpr = 1;
        let rect = parent.getBoundingClientRect();
        let glyphs: Glyph[] = [];
        let twinkles: Twinkle[] = [];
        let cellGlyph = new Uint8Array(0);
        let cellFill = new Uint8Array(0);
        let field: HTMLCanvasElement | null = null;
        let raf = 0, lastDraw = 0, visible = true;
        let last: { x: number; y: number } | null = null;
        const spawned = new Map<number, number>();

        const setup = (c: CanvasRenderingContext2D) => {
            c.setTransform(dpr, 0, 0, dpr, 0, 0);
            c.font = font;
            c.textBaseline = "top";
            c.textAlign = "left";
        };

        // ~70% of cells hold a dim glyph at their own alpha. Rendered once per resize/theme change.
        const renderField = () => {
            if (!ambient || !width) { field = null; return; }
            field ??= document.createElement("canvas");
            field.width = canvas.width;
            field.height = canvas.height;
            const f = field.getContext("2d");
            if (!f) return;
            setup(f);
            const c = palette.body;
            for (let cell = 0; cell < cols * rows; cell++) {
                if (!cellFill[cell]) continue;
                const a = ambMax * (0.45 + 0.55 * hash(cell * 7 + 3));
                f.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
                f.fillText(GLYPHS[cellGlyph[cell]], (cell % cols) * cw, ((cell / cols) | 0) * ch);
            }
        };

        const addTwinkle = (now: number, t?: Twinkle) => {
            const total = cols * rows;
            for (let tries = 0; tries < 6; tries++) {
                const cell = rnd(total);
                if (cellFill[cell]) continue; // empty cells only, so twinkles never overlap static glyphs
                const n = { cell, ch: GLYPHS[rnd(GLYPHS.length)], start: now - rnd(1200), dur: 1800 + rnd(2600) };
                if (t) Object.assign(t, n); else twinkles.push(n);
                return;
            }
        };

        // Soft-attenuate the field under text blocks (data-matrix-quiet) so small/muted text keeps >= 4.5:1.
        // Reads rects only (no writes between reads), so no layout thrash; follows scroll automatically.
        const punchQuiet = () => {
            const zones = parent.querySelectorAll("[data-matrix-quiet]");
            if (!zones.length) return;
            const q = palette.dark ? 0.5 : 0.7;
            const step = 1 - (1 - q) ** (1 / 3);
            ctx.globalCompositeOperation = "destination-out";
            ctx.fillStyle = `rgba(0,0,0,${step.toFixed(3)})`;
            for (const el of zones) {
                const r = el.getBoundingClientRect();
                if (r.bottom < rect.top || r.top > rect.bottom) continue;
                for (const pad of [16, 10, 4]) ctx.fillRect(r.left - rect.left - pad, r.top - rect.top - pad, r.width + pad * 2, r.height + pad * 2);
            }
            ctx.globalCompositeOperation = "source-over";
        };

        // Exclusion zones (data-matrix-exclude): whole cells under the element plus a one-cell margin are
        // wiped last, so no glyph (field, twinkle or trail) is drawn in or half-cut by the card edge.
        const clearExcluded = () => {
            const zones = parent.querySelectorAll("[data-matrix-exclude]");
            for (const el of zones) {
                const r = el.getBoundingClientRect();
                if (r.bottom < rect.top || r.top > rect.bottom) continue;
                const x0 = (Math.floor((r.left - rect.left) / cw) - 1) * cw;
                const y0 = (Math.floor((r.top - rect.top) / ch) - 1) * ch;
                const x1 = (Math.ceil((r.right - rect.left) / cw) + 1) * cw;
                const y1 = (Math.ceil((r.bottom - rect.top) / ch) + 1) * ch;
                ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
            }
        };

        const draw = (now: number, still = false) => {
            drawLayers(now, still);
            clearExcluded();
        };

        const drawLayers = (now: number, still: boolean) => {
            ctx.clearRect(0, 0, width, height);
            const { dark, body, head } = palette;
            if (field) ctx.drawImage(field, 0, 0, width, height);
            if (still) { punchQuiet(); return; } // reduced motion: static dim field only
            if (ambient) {
                const want = Math.min(MAX_TWINKLE, Math.max(4, (cols * rows) >> 7));
                while (twinkles.length < want) { const before = twinkles.length; addTwinkle(now); if (twinkles.length === before) break; }
                for (const t of twinkles) {
                    const p = (now - t.start) / t.dur;
                    if (p >= 1) { addTwinkle(now, t); continue; }
                    if (p < 0) continue;
                    ctx.fillStyle = `rgba(${body[0]},${body[1]},${body[2]},${(Math.sin(Math.PI * p) * ambMax * 1.1).toFixed(3)})`;
                    ctx.fillText(t.ch, (t.cell % cols) * cw, ((t.cell / cols) | 0) * ch);
                }
            }
            punchQuiet();
            // Pointer trail stacks onto the cell's ambient glyph and decays back to it.
            const peak = 0.4;
            const cap = dark ? 0.46 : 0.42; // trail only spawns over bare background, never under text
            let w = 0;
            for (let i = 0; i < glyphs.length; i++) {
                const g = glyphs[i];
                const age = now - g.born;
                if (age >= fadeMs) { spawned.delete(g.cell); continue; }
                glyphs[w++] = g;
                const t = age / fadeMs;
                const fresh = age < 90;
                const a = (1 - t) ** 1.5 * (fresh ? 1.6 * peak : peak);
                const c = fresh ? head : body;
                ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.min(a, cap).toFixed(3)})`;
                if (dark && fresh) { ctx.shadowColor = `rgba(${body[0]},${body[1]},${body[2]},0.7)`; ctx.shadowBlur = 6; }
                ctx.fillText(g.ch, g.x, g.y);
                if (dark && fresh) { ctx.shadowBlur = 0; ctx.shadowColor = "transparent"; }
            }
            glyphs.length = w;
        };

        const frame = (now: number) => {
            raf = 0;
            if (document.hidden || !visible || reduced) return;
            if (glyphs.length === 0 && now - lastDraw < AMBIENT_FRAME_MS - 2) { raf = requestAnimationFrame(frame); return; }
            lastDraw = now;
            draw(now);
            if (ambient || glyphs.length > 0) raf = requestAnimationFrame(frame);
        };
        const kick = () => { if (!raf && !document.hidden && visible && !reduced) raf = requestAnimationFrame(frame); };

        const resize = () => {
            rect = parent.getBoundingClientRect();
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            width = Math.max(1, Math.round(rect.width));
            height = Math.max(1, Math.round(rect.height));
            cols = Math.ceil(width / cw);
            rows = Math.ceil(height / ch);
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            setup(ctx);
            cellGlyph = new Uint8Array(cols * rows);
            cellFill = new Uint8Array(cols * rows);
            for (let i = 0; i < cellGlyph.length; i++) {
                cellGlyph[i] = (hash(i * 13 + 1) * GLYPHS.length) | 0;
                cellFill[i] = hash(i * 31 + 5) < 0.7 ? 1 : 0;
            }
            twinkles = [];
            renderField();
            draw(performance.now(), reduced);
            kick();
        };

        const spawn = (cx: number, cy: number, now: number) => {
            if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return;
            const cell = cy * cols + cx;
            const prev = spawned.get(cell);
            if (prev !== undefined && now - prev < CELL_COOLDOWN_MS) return;
            if (density < 1 && Math.random() > density) return;
            spawned.set(cell, now);
            const idx = cellFill[cell] ? cellGlyph[cell] : rnd(GLYPHS.length);
            glyphs.push({ cell, x: cx * cw, y: cy * ch, ch: GLYPHS[idx], born: now });
            if (glyphs.length > MAX_GLYPHS) glyphs.splice(0, glyphs.length - MAX_GLYPHS);
        };

        // Background = the parent itself or an element explicitly marked data-matrix-bg.
        const isBackground = (target: EventTarget | null) => target === parent || (target instanceof Element && target.hasAttribute("data-matrix-bg"));

        const onMove = (e: PointerEvent) => {
            if (reduced || e.pointerType === "touch" || document.hidden) return;
            if (!isBackground(e.target)) { last = null; return; } // foreground: spawn nothing, existing glyphs decay
            const now = performance.now();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            if (last) {
                const dx = x - last.x, dy = y - last.y;
                const steps = Math.min(24, Math.ceil(Math.hypot(dx, dy) / (cw * 0.8)));
                for (let s = 1; s <= steps; s++) spawn(Math.floor((last.x + (dx * s) / steps) / cw), Math.floor((last.y + (dy * s) / steps) / ch), now);
            } else spawn(Math.floor(x / cw), Math.floor(y / ch), now);
            last = { x, y };
            kick();
        };
        const onScroll = () => { if (reduced) draw(performance.now(), true); };
        const onEnter = () => { rect = parent.getBoundingClientRect(); last = null; };
        const onLeave = () => { last = null; };
        const onVisibility = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else kick(); };
        const onMotion = () => {
            reduced = motion.matches;
            if (reduced) { cancelAnimationFrame(raf); raf = 0; glyphs = []; twinkles = []; draw(performance.now(), true); } else kick();
        };

        // Re-read tokens whenever theme / material changes (next-themes class, data-theme, data-material).
        const refreshPalette = () => { palette = readPalette(parent, color); ambMax = ambFor(palette.dark); renderField(); draw(performance.now(), reduced); kick(); };
        const themeObserver = new MutationObserver(refreshPalette);
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-material", "style"] });
        const scheme = window.matchMedia("(prefers-color-scheme: dark)");
        scheme.addEventListener("change", refreshPalette);
        const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) kick(); });
        io.observe(canvas);

        const ro = new ResizeObserver(resize);
        ro.observe(parent);
        resize();
        parent.addEventListener("pointermove", onMove, { passive: true });
        parent.addEventListener("pointerenter", onEnter, { passive: true });
        parent.addEventListener("pointerleave", onLeave, { passive: true });
        parent.addEventListener("scroll", onScroll, { passive: true, capture: true });
        document.addEventListener("visibilitychange", onVisibility);
        motion.addEventListener("change", onMotion);

        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            io.disconnect();
            themeObserver.disconnect();
            scheme.removeEventListener("change", refreshPalette);
            parent.removeEventListener("pointermove", onMove);
            parent.removeEventListener("pointerenter", onEnter);
            parent.removeEventListener("pointerleave", onLeave);
            parent.removeEventListener("scroll", onScroll, { capture: true });
            document.removeEventListener("visibilitychange", onVisibility);
            motion.removeEventListener("change", onMotion);
        };
    }, [color, fontSize, fadeMs, density, ambient, ambientOpacity]);

    return <canvas ref={ref} aria-hidden="true" className={cn("pointer-events-none absolute inset-0 size-full rounded-[inherit]", className)} />;
}

export default MatrixTrail;
