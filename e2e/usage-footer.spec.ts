import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 900, height: 700 } });

test('footer usage meter renders Max, Pro and error fixtures', async ({ page }) => {
  await page.goto('/e2e/harness/usage-footer.html');
  const max = page.getByTestId('max5x');
  await expect(max.getByRole('button', { name: /Show Claude usage details/ })).toContainText('72%');
  await expect(max.getByRole('button', { name: /Show Claude usage details/ })).toContainText('w');
  await expect(page.getByTestId('pro').getByRole('button', { name: /Show Claude usage details/ })).toContainText('72%');
  const bad = page.getByTestId('forbidden').getByRole('button', { name: /Show Claude usage details/ });
  await expect(bad).toContainText('unavailable');
  await expect(bad).toHaveAttribute('title', /missing scope/);
  await max.getByRole('button', { name: /Show Claude usage details/ }).click();
  const pop = page.getByRole('dialog');
  await expect(pop.getByText('Max 5x')).toBeVisible();
  for (const t of ['Current session (5h)', 'Weekly', 'Weekly · Opus', 'Weekly · Sonnet', 'Extra usage', '$12.30 of $50.00']) await expect(pop.getByText(t, { exact: true })).toBeVisible();
  await page.screenshot({ path: '.tmp/shots/usage-footer.png' });
});
