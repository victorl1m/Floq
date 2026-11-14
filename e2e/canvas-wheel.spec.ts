import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 800, height: 600 } });
const vp = (page: Page) => page.evaluate(() => {
  const m = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')!).transform);
  return { x: m.e, y: m.f, zoom: m.a };
});
const wheel = (page: Page, x: number, y: number, init: WheelEventInit, sel?: string) => page.evaluate(([x, y, init, sel]) => {
  const target = (sel ? document.querySelector(sel) : document.elementFromPoint(x as number, y as number))!;
  target.dispatchEvent(new WheelEvent('wheel', { clientX: x as number, clientY: y as number, bubbles: true, cancelable: true, ...(init as WheelEventInit) }));
}, [x, y, init, sel] as const);
const setMode = (page: Page, mode: string) => page.evaluate((m) => { localStorage.setItem('floq.canvasScroll', m); }, mode);

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/harness/canvas-wheel.html');
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
});

test('auto: touchpad swipe pans both axes and keeps zoom', async ({ page }) => {
  await wheel(page, 300, 400, { deltaX: 30.5, deltaY: 12.25 });
  await wheel(page, 300, 400, { deltaX: 10.5, deltaY: 8.75 });
  const v = await vp(page);
  expect(v.x).toBeCloseTo(-41, 0); expect(v.y).toBeCloseTo(-21, 0); expect(v.zoom).toBeCloseTo(1, 5);
});

test('ctrl+wheel pinch zooms around the cursor, smoothly', async ({ page }) => {
  const flowAt = async (cx: number, cy: number) => { const v = await vp(page); return { x: (cx - v.x) / v.zoom, y: (cy - v.y) / v.zoom }; };
  const before = await flowAt(300, 400);
  await wheel(page, 300, 400, { deltaY: -4.5, ctrlKey: true });
  const z1 = (await vp(page)).zoom;
  expect(z1).toBeGreaterThan(1); expect(z1).toBeLessThan(1.1);
  for (let i = 0; i < 10; i++) await wheel(page, 300, 400, { deltaY: -4.5, ctrlKey: true });
  const v = await vp(page);
  expect(v.zoom).toBeGreaterThan(z1 * 1.3);
  const after = await flowAt(300, 400);
  expect(after.x).toBeCloseTo(before.x, 1); expect(after.y).toBeCloseTo(before.y, 1);
  await wheel(page, 300, 400, { deltaY: 6.5, ctrlKey: true });
  expect((await vp(page)).zoom).toBeLessThan(v.zoom);
});

test('auto: mouse-like wheel (100 notch) zooms; ctrl+notch zooms', async ({ page }) => {
  await wheel(page, 300, 400, { deltaY: -100 });
  const v = await vp(page);
  expect(v.zoom).toBeGreaterThan(1.05);
  await wheel(page, 300, 400, { deltaY: -100, ctrlKey: true });
  expect((await vp(page)).zoom).toBeGreaterThan(v.zoom);
});

test('trackpad mode: even a 100 notch pans; mouse mode: touchpad-like delta zooms', async ({ page }) => {
  await setMode(page, 'trackpad');
  await wheel(page, 300, 400, { deltaY: 100 });
  let v = await vp(page);
  expect(v.y).toBeCloseTo(-100, 0); expect(v.zoom).toBeCloseTo(1, 5);
  await setMode(page, 'mouse');
  await wheel(page, 300, 400, { deltaX: 0, deltaY: -20.5 });
  v = await vp(page);
  expect(v.zoom).toBeGreaterThan(1);
});

test('wheel over a nowheel terminal node scrolls it and leaves the canvas alone', async ({ page }) => {
  const before = await vp(page);
  const term = page.locator('[data-testid=term]');
  const box = (await term.boundingBox())!;
  const ok = await page.evaluate(([x, y]) => {
    const el = document.querySelector('[data-testid=term]')!;
    const ev = new WheelEvent('wheel', { clientX: x, clientY: y, deltaX: 0, deltaY: 7.5, bubbles: true, cancelable: true });
    el.dispatchEvent(ev); return ev.defaultPrevented;
  }, [box.x + 50, box.y + 50]);
  expect(ok).toBe(false); // native scroll is not cancelled
  await page.mouse.move(box.x + 50, box.y + 50); await page.mouse.wheel(0, 60);
  await expect.poll(() => term.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  expect(await vp(page)).toEqual(before);
});
