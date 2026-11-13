import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1100, height: 760 } });

type Msg = Record<string, any>;
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent: Msg[] }).__sent);
const mouse = async (page: Page) => (await sent(page)).filter((m) => m.type === 'input.mouse');
const clear = (page: Page) => page.evaluate(() => ((window as unknown as { __sent: unknown[] }).__sent.length = 0));
async function open(page: Page, extra = '') {
  await page.goto(`/e2e/harness/browser.html?state=running${extra}`);
  await expect(page.getByTestId('browser-frame')).toBeVisible();
  await expect.poll(async () => (await sent(page)).filter((m) => m.type === 'viewport').length).toBeGreaterThan(0);
  await clear(page);
}
/** Page point (fx, fy as fractions of the 400x200 page) -> screen point over the letterboxed image. */
async function at(page: Page, fx: number, fy: number) {
  const b = (await page.getByTestId('browser-frame').boundingBox())!;
  const k = Math.min(b.width / 400, b.height / 200);
  return { x: b.x + (b.width - 400 * k) / 2 + fx * 400 * k, y: b.y + (b.height - 200 * k) / 2 + fy * 200 * k, k };
}

test('hover moves are throttled to ~60/s and carry buttons', async ({ page }) => {
  await open(page);
  const p = await at(page, 0.2, 0.5);
  await page.mouse.move(p.x, p.y);
  const t0 = Date.now();
  await page.mouse.move(p.x + 60, p.y + 20, { steps: 60 });
  const elapsed = Date.now() - t0;
  const moves = (await mouse(page)).filter((m) => m.kind === 'mouseMoved');
  expect(moves.length).toBeGreaterThan(0);
  expect(moves.every((m) => m.buttons === 0 && m.button === 'none' && m.clickCount === 0 && m.modifiers === 0)).toBe(true);
  expect(moves.length).toBeLessThanOrEqual(Math.ceil(elapsed / 16) + 1); // never faster than one move per 16ms (~60/s), however slow the machine is
});

test('press/release carry the button and double-click counts 1,1,2,2', async ({ page }) => {
  await open(page);
  const p = await at(page, 0.25, 0.5);
  await page.mouse.move(p.x, p.y); await clear(page);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(600); // a later click is a fresh sequence
  await page.mouse.dblclick(p.x, p.y);
  const ev = (await mouse(page)).filter((m) => m.kind !== 'mouseMoved');
  expect(ev.map((m) => `${m.kind}:${m.button}:${m.clickCount}`)).toEqual([
    'mousePressed:left:1', 'mouseReleased:left:1', 'mousePressed:left:1', 'mouseReleased:left:1', 'mousePressed:left:2', 'mouseReleased:left:2']);
  expect(ev[0].buttons).toBe(1);
  expect(ev[1].buttons).toBe(0);
});

test('right and middle buttons are forwarded and no context menu opens', async ({ page }) => {
  await open(page);
  const p = await at(page, 0.5, 0.5);
  await page.mouse.move(p.x, p.y); await clear(page);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await page.mouse.click(p.x, p.y, { button: 'middle' });
  const ev = (await mouse(page)).filter((m) => m.kind !== 'mouseMoved');
  expect(ev.map((m) => `${m.kind}:${m.button}`)).toEqual(['mousePressed:right', 'mouseReleased:right', 'mousePressed:middle', 'mouseReleased:middle']);
  expect(ev[0].buttons).toBe(2);
  expect(ev[2].buttons).toBe(4);
});

test('drag sends moves with the pressed button and releases clamped outside the frame', async ({ page }) => {
  await open(page);
  const p = await at(page, 0.3, 0.4);
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await clear(page);
  await page.waitForTimeout(40);
  await page.mouse.move(p.x + 40, p.y + 10, { steps: 4 });
  await page.waitForTimeout(40);
  await page.mouse.move(1090, 750, { steps: 3 }); // far outside the image
  await page.mouse.up();
  const ev = await mouse(page);
  const moves = ev.filter((m) => m.kind === 'mouseMoved');
  expect(moves.length).toBeGreaterThan(0);
  expect(moves.every((m) => m.button === 'left' && m.buttons === 1)).toBe(true);
  const rel = ev.find((m) => m.kind === 'mouseReleased')!;
  expect(rel.x).toBeLessThanOrEqual(400); expect(rel.y).toBeLessThanOrEqual(200);
  expect(rel.x).toBeGreaterThanOrEqual(0); expect(rel.y).toBeGreaterThanOrEqual(0);
  expect(rel.button).toBe('left');
});

test('modifiers ride on mouse and wheel messages', async ({ page }) => {
  await open(page);
  const p = await at(page, 0.5, 0.5);
  await page.mouse.move(p.x, p.y); await clear(page);
  // Alt for the click: react-flow's own Shift selection overlay swallows Shift+click on a canvas (not on this harness's page).
  await page.keyboard.down('Alt');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 10);
  await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
  const press = (await mouse(page)).find((m) => m.kind === 'mousePressed')!;
  expect(press.modifiers).toBe(1);
  await expect.poll(async () => (await sent(page)).filter((m) => m.type === 'input.wheel').length).toBe(1);
  expect((await sent(page)).find((m) => m.type === 'input.wheel')!.modifiers).toBe(1 | 8);
});

test('wheel goes to the page only: dx/dy sent, canvas viewport untouched', async ({ page }) => {
  await open(page);
  const p = await at(page, 0.5, 0.5);
  await page.mouse.move(p.x, p.y); await clear(page);
  const vp = () => page.evaluate(() => (window as unknown as { __viewport: () => unknown }).__viewport());
  const before = await vp();
  await page.mouse.wheel(30, 120);
  await expect.poll(async () => (await sent(page)).filter((m) => m.type === 'input.wheel').length).toBe(1);
  const w = (await sent(page)).find((m) => m.type === 'input.wheel')!;
  expect(w.dx).toBe(30); expect(w.dy).toBe(120);
  expect(Math.abs(w.x - 200)).toBeLessThanOrEqual(2); expect(Math.abs(w.y - 100)).toBeLessThanOrEqual(2);
  expect(await vp()).toEqual(before);
});

test('cursor messages mirror onto the live view; unknown values fall back to default', async ({ page }) => {
  await open(page);
  const frame = page.getByTestId('browser-frame');
  const push = (cursor: string) => page.evaluate((c) => (window as unknown as { __push: (m: unknown) => void }).__push({ type: 'cursor', cursor: c }), cursor);
  await expect(frame).toHaveCSS('cursor', 'default');
  await push('pointer'); await expect(frame).toHaveCSS('cursor', 'pointer');
  await push('grabbing'); await expect(frame).toHaveCSS('cursor', 'grabbing');
  await push('text'); await expect(frame).toHaveCSS('cursor', 'text');
  await push('url(evil)'); await expect(frame).toHaveCSS('cursor', 'default');
});

for (const zoom of [0.5, 1, 1.75]) {
  test(`coordinates are exact at canvas zoom ${zoom}`, async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1200 });
    await open(page, `&zoom=${zoom}`);
    for (const [fx, fy, w, h] of [[0.25, 0.5, 100, 100], [0.75, 0.25, 300, 50]] as const) {
      await clear(page);
      const p = await at(page, fx, fy);
      await page.mouse.click(p.x, p.y);
      await expect.poll(async () => (await mouse(page)).some((m) => m.kind === 'mousePressed')).toBe(true);
      const press = (await mouse(page)).find((m) => m.kind === 'mousePressed')!;
      expect(Math.abs(press.x - w)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(press.y - h)).toBeLessThanOrEqual(1.5);
    }
    await page.screenshot({ path: `.tmp/shots/browser-node-zoom-${zoom}.png` });
  });
}

test('coordinates stay exact after resizing the node', async ({ page }) => {
  await open(page);
  await page.getByTestId('browser-node').click({ position: { x: 100, y: 12 } });
  const handle = page.locator('.react-flow__resize-control.handle.bottom.right');
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down(); await page.mouse.move(hb.x - 320, hb.y - 140, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(300); await clear(page);
  const p = await at(page, 0.6, 0.7);
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await mouse(page)).some((m) => m.kind === 'mousePressed')).toBe(true);
  const press = (await mouse(page)).find((m) => m.kind === 'mousePressed')!;
  expect(Math.abs(press.x - 240)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(press.y - 140)).toBeLessThanOrEqual(1.5);
});

test('Space over the node pans the canvas, but types into a focused page', async ({ page }) => {
  await open(page);
  const frame = page.getByTestId('browser-frame');
  const b = (await frame.boundingBox())!;
  await page.mouse.move(b.x + 50, b.y + 50);
  await page.keyboard.down('Space');
  await expect(frame).toHaveCSS('pointer-events', 'none');
  await page.keyboard.up('Space');
  await expect(frame).toHaveCSS('pointer-events', /^(?!none)/);
  await frame.click({ position: { x: 50, y: 50 } }); // focuses the page textarea
  await clear(page);
  await page.keyboard.down('Space');
  await expect(frame).toHaveCSS('pointer-events', /^(?!none)/);
  await page.keyboard.up('Space');
  expect((await sent(page)).filter((m) => m.type === 'input.text').map((m) => m.text).join('')).toBe(' ');
});

test('Shift+click over the page reaches the page with the Shift modifier (selection overlay does not swallow it)', async ({ page }) => {
  await open(page);
  const p = await at(page, 0.3, 0.5);
  await page.mouse.move(p.x, p.y); await clear(page);
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
  const ev = (await mouse(page)).filter((m) => m.kind !== 'mouseMoved');
  expect(ev.map((m) => m.kind)).toEqual(['mousePressed', 'mouseReleased']);
  expect(ev.every((m) => (m.modifiers & 8) === 8)).toBe(true); // CDP modifier bit 8 = Shift
});

test('Shift+drag on empty canvas still marquee-selects the node and sends nothing to the page', async ({ page }) => {
  await open(page);
  const node = page.locator('.react-flow__node-browser');
  const b = (await node.boundingBox())!;
  await clear(page);
  await page.keyboard.down('Shift');
  await page.mouse.move(b.x - 10, b.y - 10); // empty canvas just outside the node's top-left corner
  await page.mouse.down(); await page.mouse.move(b.x + 120, b.y + 160, { steps: 8 }); await page.mouse.up(); // ends over the page area
  await page.keyboard.up('Shift');
  await expect(page.locator('.canvas-node-wrap[data-selected="true"]')).toHaveCount(1);
  expect((await mouse(page)).filter((m) => m.kind !== 'mouseMoved')).toEqual([]);
});

test('in canvas Link mode the page receives no pointer input', async ({ page }) => {
  await open(page, '&link=1');
  const p = await at(page, 0.3, 0.5);
  await page.mouse.move(p.x, p.y); await clear(page);
  await page.mouse.click(p.x, p.y);
  await page.mouse.move(p.x + 40, p.y + 10, { steps: 6 });
  expect(await mouse(page)).toEqual([]);
});
