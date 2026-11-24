import { expect, test } from '@playwright/test';

const SHOTS = '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: a Markdown table renders as a table, not as raw pipes`, async ({ page }) => {
    await page.goto(`/e2e/harness/md-preview.html?theme=${theme}`);
    const doc = page.getByRole('article', { name: 'Markdown preview' });
    await expect(doc.locator('table')).toHaveCount(1);
    await expect(doc.locator('th')).toHaveText(['O quê', 'Número real', 'O que significa']);
    await expect(doc.locator('tbody tr')).toHaveCount(3);
    await expect(doc.locator('tbody tr').first().locator('td strong').first()).toHaveText('517');
    await expect(doc).not.toContainText('|---');
    await expect(doc.locator('ol li')).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/md-preview-table-${theme}.png` });
  });
}
