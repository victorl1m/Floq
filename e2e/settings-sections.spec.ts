import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 900 } });

test('Browser section holds the agent browser and egress controls', async ({ page }) => {
  await page.goto('/e2e/harness/settings.html?section=browser');
  await expect(page.getByRole('button', { name: 'Browser' }).first()).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Agent browser', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restart' })).toBeVisible();
  await expect(page.getByText('Route browser traffic through this computer')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: '.tmp/shots/settings-browser.png' });
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByText('Agent browser', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Keep agents working')).toHaveCount(0);
});

test('LLM Providers section holds the usage fallback chain', async ({ page }) => {
  await page.goto('/e2e/harness/settings.html?section=accounts');
  await expect(page.getByText('Keep agents working')).toBeVisible();
  await expect(page.getByText('Smaller Claude model')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: '.tmp/shots/settings-llm-providers.png' });
  await page.getByRole('switch', { name: 'Keep agents working' }).click();
  expect(await page.evaluate(() => (window as any).__calls.some((c: any) => c.name === 'updateSettings'))).toBe(true);
});
