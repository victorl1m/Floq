import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 420, height: 640 } });

test('lists artifacts newest first and opens one in the viewer', async ({ page }) => {
  await page.goto('/e2e/harness/artifacts.html');
  const items = page.getByRole('list', { name: 'Artifacts' }).getByRole('listitem');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText('report.md');
  await expect(items.first()).toContainText('2.0 KB');
  await expect(items.first()).toContainText('5m ago');
  await expect(page.getByText('/home/user/Artifacts/p1')).toBeVisible();
  await items.first().getByRole('button').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Contents of report.md')).toContainText('Hello report');
  await page.screenshot({ path: '.tmp/shots/artifacts-dialog.png' });
});

test('download action requests a link from the artifacts endpoint', async ({ page }) => {
  await page.goto('/e2e/harness/artifacts.html');
  await page.getByRole('button', { name: 'Download chart.png' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __links: string[] }).__links)).toEqual(['charts/chart.png']);
});

test('empty state', async ({ page }) => {
  await page.goto('/e2e/harness/artifacts.html?empty=1');
  await expect(page.getByText('No artifacts yet')).toBeVisible();
});
