// Media of the built-in WhatsApp inbox loads by itself: a photo shows a loading state, then the picture, with no click on Retry, also when the
// first tries fail for a passing reason. "Not available here" is only for a file WhatsApp no longer has. Driven from the ?demo=bubbles view.
// WAHA_SHOTS=dir (default: the Artifacts folder)
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const shots = process.env.WAHA_SHOTS ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';

async function open(page: Page, extra = '') {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/e2e/harness/waha-bubbles.html?demo=bubbles' + extra);
  await expect(page.locator('.wa-msg').first()).toBeAttached({ timeout: 20_000 });
}
async function shot(page: Page, name: string) {
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, `waha-media-${name}.png`) });
}
const msg = (page: Page, kind: string, n = 0) => page.locator(`.wa-msg[data-kind="${kind}"]`).nth(n);
const mediaCalls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: Array<{ path: string }> }).__calls.filter((c) => c.path.startsWith('/media')).map((c) => c.path));

test('a photo loads by itself: loading state first, then the picture, no Retry', async ({ page }) => {
  await open(page, '&slow=1500');
  const photo = msg(page, 'image', 0);
  await photo.scrollIntoViewIfNeeded();
  await expect(photo.locator('.wa-skel[aria-busy="true"]')).toBeVisible();
  await expect(photo.locator('.wa-gone')).toHaveCount(0);
  await shot(page, 'loading');
  await expect(photo.locator('img')).toBeVisible({ timeout: 10_000 });
  await expect(photo.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await shot(page, 'loaded');
});

test('a photo whose first tries fail for a passing reason still loads without a click', async ({ page }) => {
  await open(page, '&flaky=2');
  const photo = msg(page, 'image', 0);
  await photo.scrollIntoViewIfNeeded();
  // While it tries again the bubble keeps its loading state: never the error box.
  let sawGone = false;
  const watch = setInterval(() => { void photo.locator('.wa-gone').count().then((n) => { if (n) sawGone = true; }).catch(() => undefined); }, 100);
  await expect(photo.locator('.wa-skel[aria-busy="true"]')).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, 'retrying');
  await expect(photo.locator('img')).toBeVisible({ timeout: 15_000 });
  clearInterval(watch);
  expect(sawGone).toBe(false);
  const id = await photo.getAttribute('data-mid');
  const calls = await mediaCalls(page);
  if (id) expect(calls.filter((c) => c.includes('id=' + id)).length).toBe(3);
  else expect(calls.length).toBeGreaterThanOrEqual(3);
  await shot(page, 'loaded-after-retries');
});

test('a file that keeps failing says it could not load, and Retry loads it', async ({ page }) => {
  await open(page, '&flaky=4');
  const photo = msg(page, 'image', 0);
  await photo.scrollIntoViewIfNeeded();
  const box = photo.locator('.wa-gone');
  await expect(box).toBeVisible({ timeout: 20_000 });
  await expect(box).toContainText('Could not load this file.');
  await expect(box).not.toContainText('Not available here');
  await shot(page, 'failed');
  await box.getByRole('button', { name: 'Retry' }).click();
  await expect(photo.locator('img')).toBeVisible({ timeout: 10_000 });
});

test('a file WhatsApp no longer has says so and keeps Retry', async ({ page }) => {
  await open(page);
  const gone = msg(page, 'image', 3);
  await gone.scrollIntoViewIfNeeded();
  await expect(gone).toContainText('Not available here. Open WhatsApp on your phone to view it.');
  await expect(gone.getByRole('button', { name: 'Retry' })).toBeVisible();
  await shot(page, 'gone');
});
