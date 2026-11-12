import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1400, height: 900 } });

for (const theme of ['light', 'dark']) {
  test(`Changes sticky headers are translucent acrylic (${theme})`, async ({ page }) => {
    await page.goto('/e2e/harness/changes.html');
    await page.evaluate((t) => {
      document.documentElement.dataset.nativeMaterial = 'acrylic';
      if (t === 'dark') document.documentElement.classList.add('dark');
    }, theme);
    await page.getByRole('button', { name: /^Changes on / }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/files changed/i).first()).toBeVisible();
    const alphas = await dialog.evaluate((root) => {
      const a = (el: Element | null) => {
        if (!el) return null;
        const c = getComputedStyle(el);
        const m = c.backgroundColor.match(/[\d.]+/g)!.map(Number);
        return { alpha: m.length > 3 ? m[3] : 1, blur: c.backdropFilter };
      };
      return {
        section: a(root.querySelector('section > button.floq-sticky-head')),
        file: a(root.querySelector('.floq-sticky-head[class*="top-8"]')),
        group: a(root.querySelector('h3.floq-sticky-head')),
      };
    });
    for (const k of ['section', 'file', 'group'] as const) {
      expect(alphas[k], k).not.toBeNull();
      expect(alphas[k]!.alpha, k).toBeLessThan(1);
      expect(alphas[k]!.blur, k).toContain('blur');
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: `.tmp/shots/changes-acrylic-${theme}.png` });
  });
}
