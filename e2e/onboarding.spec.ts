import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 900 } });

const URL = '/e2e/harness/onboarding.html';
const notice = (page: import('@playwright/test').Page) => page.getByTestId('auto-approve-notice');

test('shown on first run, "Got it" dismisses and it never returns', async ({ page }) => {
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(URL);
  await expect(notice(page)).toContainText('Auto-approve is on by default');
  await expect(notice(page)).toContainText('Each person can turn this off');
  await page.screenshot({ path: '.tmp/shots/onboarding-light.png' });
  await page.getByRole('button', { name: 'Got it' }).click();
  await expect(notice(page)).toHaveCount(0);
  await page.goto(URL);
  await page.waitForTimeout(400);
  await expect(notice(page)).toHaveCount(0);
});

test('Escape also counts as seen', async ({ page }) => {
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(URL);
  await expect(notice(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(notice(page)).toHaveCount(0);
  await page.goto(URL);
  await page.waitForTimeout(400);
  await expect(notice(page)).toHaveCount(0);
});

test('settings action lands on the Claude auto-approve row, highlighted', async ({ page }) => {
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(URL);
  await page.getByRole('button', { name: 'Turn it off in Settings' }).click();
  const dlg = page.locator('.settings-dialog');
  await expect(dlg.getByRole('button', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');
  const row = dlg.locator('[data-setting-id="agents-claude-auto-approve"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/setting-flash/);
  await expect(row).toBeInViewport();
  await page.goto(URL);
  await page.waitForTimeout(400);
  await expect(notice(page)).toHaveCount(0);
});

test('dark theme screenshot', async ({ page }) => {
  await page.goto(URL + '?dark=1');
  await page.evaluate(() => localStorage.clear());
  await page.goto(URL + '?dark=1');
  await expect(notice(page)).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.tmp/shots/onboarding-dark.png' });
});

test('primary action has initial focus, so Enter just acknowledges', async ({ page }) => {
  await page.goto('/e2e/harness/onboarding.html');
  await expect(page.getByRole('button', { name: 'Got it' })).toBeFocused();
});
