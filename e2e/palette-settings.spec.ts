import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 900 } });

const dialog = (page: import('@playwright/test').Page) => page.locator('.settings-dialog');

test('Ctrl+K "proxy" opens Browser on the egress row and highlights it, keyboard only', async ({ page }) => {
  await page.goto('/e2e/harness/palette-settings.html');
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search workspace' }).fill('proxy');
  const first = page.getByRole('option').first();
  await expect(first).toContainText('Browser › Route browser traffic through this computer');
  await page.screenshot({ path: '.tmp/shots/palette-settings.png' });
  await page.keyboard.press('Enter');
  await expect(dialog(page).getByRole('button', { name: 'Browser' })).toHaveAttribute('aria-current', 'page');
  const row = dialog(page).locator('[data-setting-id="browser-egress"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/setting-flash/);
  await expect(row).toBeInViewport();
});

test('"avatar" lands on Appearance, row highlighted', async ({ page }) => {
  await page.goto('/e2e/harness/palette-settings.html');
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search workspace' }).fill('avatar');
  await expect(page.getByRole('option').first()).toContainText('Appearance › Robot avatars');
  await page.keyboard.press('Enter');
  await expect(dialog(page).getByRole('button', { name: 'Appearance' })).toHaveAttribute('aria-current', 'page');
  await expect(dialog(page).locator('[data-setting-id="appearance-robot-avatars"]')).toHaveClass(/setting-flash/);
});

test('"settings" and a section name list sections; Users only for admins', async ({ page }) => {
  await page.goto('/e2e/harness/palette-settings.html');
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: 'Search workspace' });
  await input.fill('settings');
  const group = page.getByRole('group', { name: 'Settings' });
  await expect(group.getByRole('option', { name: /Browser/ })).toBeVisible();
  await expect(group.getByRole('option', { name: /Users/ })).toHaveCount(0);
  await input.fill('perf');
  await page.keyboard.press('Enter');
  await expect(dialog(page).getByRole('button', { name: 'Performance' })).toHaveAttribute('aria-current', 'page');

  await page.goto('/e2e/harness/palette-settings.html?admin=1');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search workspace' }).fill('users');
  await expect(page.getByRole('group', { name: 'Settings' }).getByRole('option', { name: /Users/ })).toBeVisible();
});

test('hover cursors: native pointer on trigger and items, text on the input', async ({ page }) => {
  await page.goto('/e2e/harness/palette-settings.html');
  const cursor = (loc: import('@playwright/test').Locator) => loc.evaluate((el) => getComputedStyle(el).cursor);
  expect(await cursor(page.getByTestId('search-trigger'))).toBe('pointer');
  expect(await cursor(page.getByTestId('search-trigger').locator('kbd'))).toBe('pointer');
  await page.getByTestId('search-trigger').click();
  expect(await cursor(page.getByRole('option').first())).toBe('pointer');
  expect(await cursor(page.getByRole('combobox', { name: 'Search workspace' }))).toBe('text');
});
