import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1100, height: 700 } });

test('a running display appears as a canvas node', async ({ page }) => {
  await page.goto('/e2e/harness/appwindow.html');
  const node = page.getByTestId('app-window-node');
  await expect(node).toBeVisible();
  await expect(node).toContainText('App window · Builder');
});

test('no node while the display is not running', async ({ page }) => {
  await page.goto('/e2e/harness/appwindow.html?running=0');
  await page.waitForTimeout(500);
  await expect(page.getByTestId('app-window-node')).toHaveCount(0);
});
