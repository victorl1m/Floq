import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1400, height: 900 } });

for (const theme of ['light', 'dark']) {
  test(`Files file dialog shows breadcrumb and scrollable contents (${theme})`, async ({ page }) => {
    await page.goto(`/e2e/harness/files.html?theme=${theme}`);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('File path')).toBeVisible();
    await expect(dialog.getByText('example.ts', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel(/Contents of/)).toContainText('value119');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `.tmp/shots/files-dialog-${theme}.png` });
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => page.title()).toBe('closed');
  });
}
