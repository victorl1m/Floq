import { test, expect } from '@playwright/test';
import { boot, layouts, shell } from './island-helpers';

test('hover expands, leaving collapses back to the pill and the shell never vanishes', async ({ page }) => {
  await boot(page);
  await page.waitForTimeout(500);
  expect((await shell(page)).h).toBe(40);
  await page.screenshot({ path: '.tmp/island-pw/1-collapsed.png' });
  await page.locator('.island').hover();
  await expect(page.locator('.island.expanded')).toBeVisible();
  await page.waitForTimeout(600);
  expect((await shell(page)).h).toBeGreaterThan(60);
  await page.screenshot({ path: '.tmp/island-pw/2-expanded.png' });
  await page.mouse.move(2000, 2000);
  await page.waitForTimeout(900);
  const after = await shell(page);
  expect(after.cls).toContain('collapsed');
  expect(after.h).toBe(40);
  const last = (await layouts(page)).at(-1);
  expect(last).toMatchObject({ expanded: false, height: 40 });
  await page.screenshot({ path: '.tmp/island-pw/3-collapsed-again.png' });
});

test('expanding sends one growing layout without a second near-identical step', async ({ page }) => {
  await boot(page);
  await page.locator('.island').hover();
  await page.waitForTimeout(800);
  const expanded = (await layouts(page)).filter(l => l.expanded);
  // Content settling may cause one height-only follow-up at most, never two.
  expect(expanded.length).toBeLessThanOrEqual(2);
  for (const l of expanded) expect(l.height).toBeGreaterThan(40);
});

test('the native island:hover collapse is ignored while the pointer is over the island, honoured once it left', async ({ page }) => {
  await boot(page);
  await page.locator('.island').hover();
  await expect(page.locator('.island.expanded')).toBeVisible();
  await page.evaluate(() => (window as any).__emit('island:hover', { expanded: false }));
  await page.waitForTimeout(800);
  expect((await shell(page)).cls).toContain('expanded');
  await page.mouse.move(220, 500);
  await page.evaluate(() => (window as any).__emit('island:hover', { expanded: false }));
  await expect(page.locator('.island.collapsed')).toBeVisible({ timeout: 2000 });
  await page.evaluate(() => (window as any).__emit('island:hover', { expanded: true }));
  await expect(page.locator('.island.expanded')).toBeVisible();
});
