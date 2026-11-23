import { expect, test } from '@playwright/test';

const SHOTS = '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
const results = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __results: Array<[string, boolean]> }).__results);

test('wake confirm: the action is focused and Enter wakes and sends', async ({ page }) => {
  await page.goto('/e2e/harness/ask-dialog.html?theme=dark');
  await page.getByTestId('wake').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wake and send' })).toBeFocused();
  await page.screenshot({ path: `${SHOTS}/ask-dialog-wake-enter.png` });
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  expect(await results(page)).toEqual([['wake', true]]);
});

test('wake confirm: Escape still cancels', async ({ page }) => {
  await page.goto('/e2e/harness/ask-dialog.html');
  await page.getByTestId('wake').click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toBeHidden();
  expect(await results(page)).toEqual([['wake', false]]);
});

test('a destructive confirm keeps Cancel as the Enter default even when asked otherwise', async ({ page }) => {
  await page.goto('/e2e/harness/ask-dialog.html');
  await page.getByTestId('plain').click();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog')).toBeHidden();
  expect(await results(page)).toEqual([['plain', false]]);
});
