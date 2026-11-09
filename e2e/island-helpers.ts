import { expect, type Page } from '@playwright/test';

const agent = { sessionId: 's', name: 'a', role: 'r', project: 'p' };
export const approval = (id: string, action = 'git push origin main') => ({ kind: 'approval', id, createdAt: '2026-01-01T00:00:00Z', approval: {
  id, requester: agent, target: agent, action, detail: 'push', irreversible: true,
  createdAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', remainingMs: 60000, timeoutMs: 60000 } });
export const snapshot = (items = [approval('a1')], revision = 1) => ({ epoch: 'e1', revision, connected: true, busy: [], items });

/** Pointer positions inside / outside the (collapsed, 220px wide, centered) capsule of the 440px viewport. */
export const IN = { x: 220, y: 20 };
export const OUT = { x: 220, y: 500 };

/**
 * Mocks the Tauri bridge. island_set_layout answers like the native command after `layoutDelay` ms
 * (440/220 wide, requested height) and tracks the "native window" in window.__native.
 * A rAF sampler (window.__sample.start/stop) records .island height, pill and content opacity per frame.
 */
export async function boot(page: Page, opts: { layoutDelay?: number; items?: ReturnType<typeof approval>[] } = {}) {
  await page.addInitScript((layoutDelay: number) => {
    const w = window as any;
    w.__calls = []; w.__native = { expanded: false, height: 40 };
    const callbacks = new Map<number, (e: unknown) => void>(); const listeners: Record<string, number[]> = {}; let id = 1;
    w.__emit = (event: string, payload: unknown) => (listeners[event] ?? []).forEach(h => callbacks.get(h)?.({ event, id: 0, payload }));
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback(cb: (e: unknown) => void) { const n = id++; callbacks.set(n, cb); return n; },
      unregisterCallback() {},
      convertFileSrc: (s: string) => s,
      async invoke(cmd: string, args: any) {
        if (cmd === 'plugin:event|listen') { (listeners[args.event] ??= []).push(args.handler); return id++; }
        if (cmd === 'plugin:event|unlisten') return;
        w.__calls.push({ cmd, args, t: performance.now() });
        if (cmd === 'island_set_layout') {
          await new Promise(r => setTimeout(r, layoutDelay));
          w.__native = { expanded: !!args.expanded, height: args.expanded ? args.height : 40 };
          return { width: args.expanded ? 440 : 220, height: args.expanded ? args.height : 40 };
        }
      },
    };
    let frames: any[] = []; let running = false;
    const tick = () => {
      if (!running) return;
      const el = document.querySelector('.island') as HTMLElement | null;
      if (el) {
        const hd = el.querySelector('.island-header'), ct = el.querySelector('.island-content');
        frames.push({ t: performance.now(), h: el.getBoundingClientRect().height,
          hp: hd ? +getComputedStyle(hd).opacity : 0, hc: ct ? +getComputedStyle(ct).opacity : 0, cls: el.classList.contains('expanded') ? 'E' : 'C' });
      }
      requestAnimationFrame(tick);
    };
    w.__sample = { start() { frames = []; running = true; requestAnimationFrame(tick); }, stop() { running = false; return frames; }, mark: () => performance.now() };
  }, opts.layoutDelay ?? 30);
  await page.goto('/?window=island');
  await page.evaluate(s => (window as any).__emit('island:snapshot', s), snapshot(opts.items));
  await expect(page.locator('.island')).toBeVisible();
  await page.waitForTimeout(500);
}
export type Frame = { t: number; h: number; hp: number; hc: number; cls: 'E' | 'C' };
export const startSampling = (page: Page) => page.evaluate(() => (window as any).__sample.start());
export const stopSampling = (page: Page) => page.evaluate(() => (window as any).__sample.stop() as Frame[]);
export const mark = (page: Page) => page.evaluate(() => (window as any).__sample.mark() as number);
export const layouts = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'island_set_layout').map((c: any) => ({ ...c.args, t: c.t })));
export const native = (page: Page) => page.evaluate(() => (window as any).__native as { expanded: boolean; height: number });
export const shell = (page: Page) => page.locator('.island').evaluate(e => ({ h: e.getBoundingClientRect().height, cls: e.className }));
export const pointer = (page: Page, p: { x: number; y: number }) => page.mouse.move(p.x, p.y);

/** Never both the pill and the content visibly opaque in the same frame. */
export const maxOverlap = (frames: Frame[]) => frames.reduce((m, f) => Math.max(m, Math.min(f.hp, f.hc)), 0);
export const bothAbove = (frames: Frame[], limit = 0.6) => frames.filter(f => f.hp > limit && f.hc > limit);
export const maxFrameStep = (frames: Frame[]) => frames.slice(1).reduce((m, f, i) => Math.max(m, Math.abs(f.h - frames[i].h)), 0);
export const dips = (frames: Frame[], tolerance = 0.5) => frames.slice(1).filter((f, i) => f.h < frames[i].h - tolerance);
export const summary = (frames: Frame[]) => ({ frames: frames.length, hMin: +Math.min(...frames.map(f => f.h)).toFixed(1), hMax: +Math.max(...frames.map(f => f.h)).toFixed(1),
  maxStep: +maxFrameStep(frames).toFixed(1), maxOverlap: +maxOverlap(frames).toFixed(2), dips: dips(frames).length });
