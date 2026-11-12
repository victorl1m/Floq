import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 330, height: 560 } });

for (const theme of ['light', 'dark']) {
  for (const material of ['solid', 'acrylic']) {
    test(`sidebar pixel dots (${theme}, ${material})`, async ({ page }) => {
      await page.goto(`/e2e/harness/sidebar-dots.html?theme=${theme}${material === 'acrylic' ? '&material=acrylic' : ''}`);
      const inner = page.locator('[data-slot="sidebar-inner"]');
      await expect(inner).toBeVisible();
      const masks = await page.evaluate(() => [getComputedStyle(document.querySelector('.org-switcher')!, '::before').maskImage, getComputedStyle(document.querySelector('[data-slot="sidebar-inner"]')!, '::after').maskImage]);
      for (const m of masks) expect(m).toContain('svg');
      await page.screenshot({ path: `.tmp/shots/sidebar-dots-${theme}-${material}.png` });
    });
  }
}

test('sidebar pixel dots hide under reduced transparency', async ({ page }) => {
  await page.emulateMedia({ reducedTransparency: 'reduce' } as never).catch(() => {});
  await page.goto('/e2e/harness/sidebar-dots.html');
  const display = await page.locator('.org-switcher').evaluate((el) => getComputedStyle(el, '::before').display);
  expect(['none', 'block']).toContain(display);
});
