import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { boot, IN, OUT, pointer, startSampling, stopSampling, mark, layouts, native, shell, bothAbove, dips, maxFrameStep, maxOverlap, summary, type Frame } from './island-helpers';

const SHOTS = '.tmp/island-pw';
const results: Record<string, unknown> = {};
const record = (name: string, value: unknown) => { results[name] = value; console.log(`[motion] ${name} ${JSON.stringify(value)}`); fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(`${SHOTS}/motion-${name.split(' ')[0]}.json`, JSON.stringify(value)); };
/** island_set_layout calls that shrink the window after it first expanded (the initial 40px layout at boot does not count). */
const shrinksAfterExpand = async (page: import('@playwright/test').Page) => { const calls = await layouts(page); const first = calls.findIndex(l => l.expanded); return first < 0 ? [] : calls.slice(first).filter(l => !l.expanded); };
const expandedHeight = async (page: import('@playwright/test').Page) => (await shell(page)).h;

test.describe('island hover motion (rAF frame sampling)', () => {
  test.beforeEach(async ({ page }) => { await boot(page); });

  test('(a) hover expand: height never decreases, pill and content never both opaque', async ({ page }) => {
    await startSampling(page);
    await pointer(page, IN);
    await page.waitForTimeout(150); await page.screenshot({ path: `${SHOTS}/a-150ms.png` });
    await page.waitForTimeout(650);
    const frames = await stopSampling(page);
    const final = await expandedHeight(page);
    record('a expand', { ...summary(frames), final, overlapFrames: bothAbove(frames).length });
    expect(final).toBeGreaterThan(60);
    expect(dips(frames), 'height must be monotonic non-decreasing').toHaveLength(0);
    expect(Math.abs(frames.at(-1)!.h - final)).toBeLessThan(0.5);
    expect(bothAbove(frames), 'pill and content both > 0.6').toHaveLength(0);
    expect(maxFrameStep(frames)).toBeLessThan((final - 40) * 0.5);
    expect(frames.at(-1)!.hc).toBeCloseTo(1, 1); expect(frames.at(-1)!.hp).toBeCloseTo(0, 1);
    await page.screenshot({ path: `${SHOTS}/a-expanded.png` });
  });

  for (const [label, wait] of [['b1 re-hover 150ms after the leave (leave timer still pending)', 150], ['b2 re-hover 150ms into the visual collapse', 450], ['b3 re-hover 80ms into the visual collapse', 380], ['b4 re-hover after the native window shrank (needs the resize round trip)', 750]] as const) {
    test(`(${label.slice(0, 2)}) ${label.slice(3)}: reverses smoothly, no dip to 40 and regrow`, async ({ page }) => {
      await pointer(page, IN); await page.waitForTimeout(800);
      const final = await expandedHeight(page);
      await startSampling(page);
      await pointer(page, OUT);
      await page.waitForTimeout(wait);
      const tRe = await mark(page); await pointer(page, IN);
      await page.waitForTimeout(40); await page.screenshot({ path: `${SHOTS}/${label.slice(0, 2)}-just-after-rehover.png` });
      await page.waitForTimeout(900);
      const frames = await stopSampling(page);
      // The mouse event reaches React asynchronously: measure from the frame where the capsule flips back to expanded
      // (b1: it never left it). Frames between the pointer event and that flip are reported as `lagFrames`.
      const sinceMove = frames.filter(f => f.t >= tRe);
      const flip = sinceMove.findIndex(f => f.cls === 'E');
      const after = sinceMove.slice(Math.max(0, flip));
      const atRe = after[0];
      record(label.slice(0, 2) + ' rehover', { ...summary(frames), lagFrames: Math.max(0, flip), hAtPointerMove: +sinceMove[0].h.toFixed(1), hAtRehover: +atRe.h.toFixed(1), final, hAfterMin: +Math.min(...after.map(f => f.h)).toFixed(1), overlapFrames: bothAbove(frames).length,
        afterOverlap: +maxOverlap(after).toFixed(2), afterMaxStep: +maxFrameStep(after).toFixed(1) });
      expect(dips(after), 'height from the re-hover moment must be monotonic non-decreasing').toHaveLength(0);
      expect(Math.min(...after.map(f => f.h))).toBeGreaterThan(atRe.h - 0.5);
      expect(maxFrameStep(after)).toBeLessThan((final - 40) * 0.5);
      expect(bothAbove(frames)).toHaveLength(0);
      expect((await shell(page)).cls).toContain('expanded');
      expect(Math.abs(await expandedHeight(page) - final)).toBeLessThan(0.5);
      expect(after.at(-1)!.hc).toBeCloseTo(1, 1); expect(after.at(-1)!.hp).toBeCloseTo(0, 1);
      // the window must never have been asked to shrink (b1) / the visual must stay in step with the native state
      if (wait === 150) expect(await shrinksAfterExpand(page)).toHaveLength(0);
    });
  }

  test('(c) unhover mid-expand reverses smoothly and ends collapsed', async ({ page }) => {
    await startSampling(page);
    await pointer(page, IN);
    await page.waitForTimeout(110);
    const tOut = await mark(page);
    await pointer(page, OUT);
    await page.waitForTimeout(1300);
    const frames = await stopSampling(page);
    const out = frames.filter(f => f.t >= tOut);
    const peak = Math.max(...out.map(f => f.h));
    // after the peak the height must only go down
    const iPeak = out.findIndex(f => f.h === peak);
    const down = out.slice(iPeak).slice(1).filter((f, i) => f.h > out.slice(iPeak)[i].h + 0.5);
    record('c unhover-mid-expand', { ...summary(frames), peak: +peak.toFixed(1), hEnd: frames.at(-1)!.h, upsAfterPeak: down.length, overlapFrames: bothAbove(frames).length });
    expect(down).toHaveLength(0);
    expect(bothAbove(frames)).toHaveLength(0);
    expect(frames.at(-1)!.h).toBe(40);
    expect((await shell(page)).cls).toContain('collapsed');
    expect(frames.at(-1)!.hp).toBeCloseTo(1, 1); expect(frames.at(-1)!.hc).toBeCloseTo(0, 1);
    await page.waitForTimeout(300);
    expect(await native(page)).toEqual({ expanded: false, height: 40 });
    await page.screenshot({ path: `${SHOTS}/c-collapsed.png` });
  });

  for (const endExpanded of [false, true]) {
    test(`(d) stress: 10 rapid enter/leave cycles (60-250ms) end ${endExpanded ? 'on enter' : 'on leave'} and settle to the last input`, async ({ page }) => {
      const gaps = [60, 250, 90, 140, 70, 200, 110, 160, 80, 230, 120, 180, 100, 60, 240, 130, 75, 210, 95, 150];
      await startSampling(page);
      for (let i = 0; i < 10; i++) {
        await pointer(page, IN); await page.waitForTimeout(gaps[2 * i]);
        await pointer(page, OUT); await page.waitForTimeout(gaps[2 * i + 1]);
      }
      if (endExpanded) await pointer(page, IN);
      const tLast = await mark(page);
      await page.waitForTimeout(1200);
      const frames = await stopSampling(page);
      const settled = frames.filter(f => f.t > tLast + 900);
      const sh = await shell(page); const nat = await native(page); const calls = await layouts(page);
      const last = calls.at(-1);
      record(`d${endExpanded ? 2 : 1} stress`, { ...summary(frames), endExpanded, finalCls: sh.cls.includes('expanded') ? 'expanded' : 'collapsed', finalHeight: sh.h, native: nat, layoutCalls: calls.length, overlapFrames: bothAbove(frames).length });
      expect(bothAbove(frames)).toHaveLength(0);
      expect(sh.cls.includes('expanded')).toBe(endExpanded);
      expect(nat.expanded).toBe(endExpanded);
      expect(last?.expanded ?? false).toBe(endExpanded);
      if (endExpanded) { expect(sh.h).toBeGreaterThan(60); expect(Math.abs(sh.h - nat.height)).toBeLessThan(0.5); expect(settled.at(-1)!.hc).toBeCloseTo(1, 1); expect(settled.at(-1)!.hp).toBeCloseTo(0, 1); }
      else { expect(sh.h).toBe(40); expect(nat.height).toBe(40); expect(settled.at(-1)!.hp).toBeCloseTo(1, 1); expect(settled.at(-1)!.hc).toBeCloseTo(0, 1); }
      // frames after settling are perfectly still
      expect(Math.max(...settled.map(f => f.h)) - Math.min(...settled.map(f => f.h))).toBeLessThan(0.5);
      await page.screenshot({ path: `${SHOTS}/d-${endExpanded ? 'ends-expanded' : 'ends-collapsed'}.png` });
    });
  }

  test('(e) native island:hover {expanded:false} while the pointer is over the island does NOT collapse it', async ({ page }) => {
    await pointer(page, IN); await page.waitForTimeout(700);
    await startSampling(page);
    for (let i = 0; i < 3; i++) { await page.evaluate(() => (window as any).__emit('island:hover', { expanded: false })); await page.waitForTimeout(120); }
    await page.waitForTimeout(700);
    const frames = await stopSampling(page);
    const h = (await shell(page)).h;
    record('e native-collapse-while-hovered', { ...summary(frames), final: h, cls: (await shell(page)).cls.includes('expanded') ? 'expanded' : 'collapsed', layoutCalls: (await layouts(page)).length });
    expect((await shell(page)).cls).toContain('expanded');
    expect(Math.max(...frames.map(f => f.h)) - Math.min(...frames.map(f => f.h))).toBeLessThan(0.5);
    expect(await shrinksAfterExpand(page)).toHaveLength(0);
  });
});
