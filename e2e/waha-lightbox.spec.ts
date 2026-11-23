// The WhatsApp photo viewer (lightbox) inside the real host shell: the app sidebar beside the .workspace-frame (harness ?shell=1).
// The viewer covers exactly the WhatsApp view, never the sidebar; a photo of any shape fits the stage; zoom stays clipped to it.
// WAHA_SHOTS=dir (default: the Artifacts folder) writes waha-lightbox-*.png.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

const shots = process.env.WAHA_SHOTS ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
const MARINA = '5511987654321@c.us';
const SIZES = [[1600, 900], [3000, 1000], [900, 2400]] as const;
const MATERIALS = { acrylic: 'material=acrylic&native=acrylic', solid: 'material=solid' };
type Box = { x: number; y: number; width: number; height: number };

const box = async (l: Locator) => (await l.boundingBox()) as Box;
const inside = (inner: Box, outer: Box, slack = 1) => {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - slack);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - slack);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + slack);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + slack);
};
const same = (a: Box, b: Box) => { for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(a[k] - b[k]), k).toBeLessThanOrEqual(1); };

async function open(page: Page, theme: string, material: keyof typeof MATERIALS, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.goto('/e2e/harness/waha.html?shell=1&' + MATERIALS[material] + (theme === 'dark' ? '&theme=dark' : ''));
  await page.locator('.wa-row', { hasText: 'Marina Costa' }).click();
  await expect(page.locator('.wa-composer')).toBeVisible();
  // three photos arrive: a 16:9 screenshot, a panorama and a tall one
  await page.evaluate(([chat, sizes]) => {
    const fake = (window as unknown as { __incoming: (c: string, b: string, s?: string, n?: string, extra?: object) => void }).__incoming;
    for (const [w, h] of sizes as number[][]) fake(chat as string, 'Foto ' + w + 'x' + h, chat as string, '', { type: 'image', hasMedia: true, media: { mime: 'image/jpeg', filename: '', size: null, duration: null, width: w, height: h, gif: false, available: true } });
  }, [MARINA, SIZES] as const);
  await expect(page.locator('.wa-msg', { hasText: 'Foto 900x2400' })).toBeVisible();
}
async function view(page: Page, w: number, h: number) {
  const b = page.locator('.wa-msg', { hasText: 'Foto ' + w + 'x' + h }).last();
  await b.scrollIntoViewIfNeeded();
  await b.locator('.wa-img-btn').click();
  const lb = page.getByRole('dialog', { name: 'Photo viewer' });
  await expect(lb.locator('.wa-lb-stage img')).toBeVisible();
  await expect.poll(() => lb.locator('.wa-lb-stage img').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(w);
  return lb;
}
async function shot(page: Page, name: string) {
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, 'waha-lightbox-' + name + '.png') });
}
/** The viewer is the top layer over every point of the WhatsApp view, and is not over the sidebar. */
async function covers(page: Page, lb: Locator, root: Box) {
  const top = (x: number, y: number) => page.evaluate(([px, py]) => Boolean(document.elementFromPoint(px, py)?.closest('.wa-lb')), [x, y]);
  for (const [fx, fy] of [[0.02, 0.03], [0.5, 0.5], [0.98, 0.97], [0.03, 0.96], [0.2, 0.5]]) expect(await top(root.x + root.width * fx, root.y + root.height * fy), 'covered at ' + fx + ',' + fy).toBe(true);
  same(await box(lb), root);
}

for (const theme of ['dark', 'light']) for (const material of ['acrylic', 'solid'] as const) {
  test(theme + ' ' + material + ': the viewer covers the WhatsApp view, not the sidebar, and every photo fits the stage', async ({ page }) => {
    await open(page, theme, material, { width: 1500, height: 820 });
    const side = await box(page.locator('[data-slot="sidebar-container"]'));
    expect(side.width).toBeGreaterThan(200);
    for (const [w, h] of SIZES) {
      const lb = await view(page, w, h);
      const root = await box(page.locator('.wa-root'));
      expect(root.x).toBeGreaterThanOrEqual(side.x + side.width - 1);
      await covers(page, lb, root);
      const stage = await box(lb.locator('.wa-lb-stage')), img = await box(lb.locator('.wa-lb-stage img'));
      inside(stage, root);
      inside(img, stage);
      // contained and centred: one side fills the stage's content box (or the photo is at its natural size), the ratio is kept
      expect(Math.abs(img.width / img.height - w / h)).toBeLessThan(0.02);
      expect(Math.abs(img.x + img.width / 2 - (stage.x + stage.width / 2))).toBeLessThanOrEqual(1);
      expect(Math.abs(img.y + img.height / 2 - (stage.y + stage.height / 2))).toBeLessThanOrEqual(1);
      for (const l of [lb.getByRole('button', { name: 'Previous photo' }), lb.getByRole('button', { name: 'Next photo' }), lb.locator('.wa-lb-cap'), lb.locator('.wa-lb-top')]) if (await l.count()) inside(await box(l), root);
      // the sidebar is not under the viewer: it stays clickable and unpainted
      expect(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('[data-slot="sidebar-container"]')), [side.x + side.width / 2, side.y + side.height / 2])).toBe(true);
      await shot(page, theme + '-' + material + '-wide-' + w + 'x' + h);
      await page.keyboard.press('Escape');
      await expect(lb).toHaveCount(0);
    }
  });
}

test('zoom and pan stay clipped to the stage; arrows and Esc still work', async ({ page }) => {
  await open(page, 'dark', 'acrylic', { width: 1500, height: 820 });
  const lb = await view(page, 1600, 900);
  const root = await box(page.locator('.wa-root')), stage = lb.locator('.wa-lb-stage'), img = stage.locator('img');
  const before = await box(img);
  for (let i = 0; i < 4; i++) await lb.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => (await box(img)).width).toBeGreaterThan(before.width * 2);
  const s = await box(stage);
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down(); await page.mouse.move(s.x + s.width / 2 - 300, s.y + s.height / 2 - 120, { steps: 5 }); await page.mouse.up();
  const zoomed = await box(img);
  expect(zoomed.width).toBeGreaterThan(s.width);
  expect(Math.abs(zoomed.x + zoomed.width / 2 - (s.x + s.width / 2 - 300))).toBeLessThan(3);
  // the zoomed photo is clipped: nothing of it is the top layer outside the stage, and the stage did not grow
  expect(await stage.evaluate((el) => getComputedStyle(el).overflow)).toBe('hidden');
  same(await box(stage), s);
  inside(s, root);
  const sideHit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [root.x - 40, s.y + s.height / 2]);
  expect(sideHit).not.toBe('IMG');
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [s.x + s.width / 2, s.y - 20])).not.toBe('IMG');
  await shot(page, 'dark-acrylic-wide-zoom');
  await page.keyboard.press('0');
  await expect.poll(async () => Math.round((await box(img)).width)).toBe(Math.round(before.width));
  await page.keyboard.press('ArrowRight');
  await expect(lb.locator('.wa-lb-stage img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lb).toHaveCount(0);
});

for (const theme of ['dark', 'light']) {
  test(theme + ': 380px narrow window: the viewer is the WhatsApp view and every photo fits', async ({ page }) => {
    await open(page, theme, 'acrylic', { width: 380, height: 760 });
    for (const [w, h] of SIZES) {
      const lb = await view(page, w, h);
      const root = await box(page.locator('.wa-root'));
      await covers(page, lb, root);
      const stage = await box(lb.locator('.wa-lb-stage')), img = await box(lb.locator('.wa-lb-stage img'));
      inside(stage, root);
      inside(img, stage);
      expect(Math.abs(img.width / img.height - w / h)).toBeLessThan(0.03);
      for (const l of [lb.getByRole('button', { name: 'Previous photo' }), lb.getByRole('button', { name: 'Next photo' }), lb.locator('.wa-lb-cap')]) if (await l.count()) inside(await box(l), root);
      await shot(page, theme + '-acrylic-narrow-' + w + 'x' + h);
      await page.keyboard.press('Escape');
      await expect(lb).toHaveCount(0);
    }
  });
}
