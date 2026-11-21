import { expect, test } from '@playwright/test';

// The sidebar menu button sizes every descendant svg to 16px ([&_svg]:size-4); the generated icon must still fill its avatar.
test('the generated org icon fills its avatar inside a sidebar menu button', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 300 });
  await page.goto('/e2e/harness/sidebar-states.html?theme=dark');
  const avatar = page.getByTestId('org-switcher').getByTestId('org-avatar');
  await expect(avatar.locator('svg')).toBeVisible();
  const [a, s] = await Promise.all([avatar.boundingBox(), avatar.locator('svg').boundingBox()]);
  expect(Math.round(s!.width)).toBe(Math.round(a!.width));
  expect(Math.round(s!.height)).toBe(Math.round(a!.height));
  await page.getByTestId('org-switcher').screenshot({ path: test.info().outputPath('org-switcher.png') });
});
