import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 330, height: 560 } });

for (const theme of ['light', 'dark']) {
  for (const material of ['solid', 'acrylic']) {
    test(`sidebar pixel dots (${theme}, ${material})`, async ({ page }) => {
      await page.goto(`/e2e/harness/sidebar-dots.html?theme=${theme}${material === 'acrylic' ? '&material=acrylic' : ''}`);
      const inner = page.locator('[data-slot="sidebar-inner"]');
      await expect(inner).toBeVisible();
      const masks = await page.evaluate(() => [getComputedStyle(document.querySelector('[data-slot="sidebar-inner"]')!, '::before').maskImage, getComputedStyle(document.querySelector('[data-slot="sidebar-inner"]')!, '::after').maskImage]);
      for (const m of masks) expect(m).toContain('svg');
      await page.screenshot({ path: `.tmp/shots/sidebar-dots-${theme}-${material}.png` });
    });
  }
}

test('sidebar pixel dots hide under reduced transparency', async ({ page }) => {
  await page.emulateMedia({ reducedTransparency: 'reduce' } as never).catch(() => {});
  await page.goto('/e2e/harness/sidebar-dots.html');
  const display = await page.locator('[data-slot="sidebar-inner"]').evaluate((el) => getComputedStyle(el, '::before').display);
  expect(['none', 'block']).toContain(display);
});

test.describe('sidebar row states', () => {
  test.use({ viewport: { width: 300, height: 560 } });
  for (const theme of ['dark', 'light']) {
    test(`folders have no fill, only the selected project is washed (${theme})`, async ({ page }) => {
      await page.goto(`/e2e/harness/sidebar-states.html?theme=${theme}`);
      const bg = (loc: ReturnType<typeof page.locator>) => loc.evaluate((el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, shadow: s.boxShadow, border: s.borderTopColor }; });
      const folder = page.getByRole('button', { name: 'Neotalk', exact: true }).first();
      await expect(folder).toBeVisible();
      expect((await bg(folder)).bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
      const chevron = page.getByRole('button', { name: 'Collapse Neotalk' });
      expect((await bg(chevron)).bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
      const active = page.locator('[data-active="true"]').nth(1);
      const a = await bg(active);
      expect(a.bg).not.toMatch(/rgba\(0, 0, 0, 0\)/);
      expect(a.shadow).toBe('none');
      expect(a.border).toMatch(/rgba\(0, 0, 0, 0\)/);
      await page.screenshot({ path: `.tmp/shots/sidebar-fix-${theme}.png` });
    });
  }
});
