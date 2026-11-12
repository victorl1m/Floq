import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1000, height: 900 } });

test('role picker: icons on every option, no Orchestrator option, switch drives the role', async ({ page }) => {
  await page.goto('/e2e/harness/roles.html');
  const dialog = page.getByRole('dialog');
  const trigger = dialog.locator('#agent-role');
  await expect(trigger).toBeVisible();
  await expect(trigger.locator('svg').first()).toBeVisible(); // icon in the closed trigger
  await trigger.click();
  const options = page.getByRole('option');
  await expect(options).toHaveCount(6); // Generalist + 5 roles
  await expect(options.filter({ hasText: 'Orchestrator' })).toHaveCount(0);
  for (let i = 0; i < 6; i++) await expect(options.nth(i).locator('svg').first()).toBeVisible();
  await page.screenshot({ path: '.tmp/shots/role-picker.png' });
  await options.filter({ hasText: 'Reviewer' }).click();
  await expect(trigger).toContainText('Reviewer');

  const sw = dialog.locator('#agent-orchestrator');
  await expect(sw).not.toBeChecked();
  await sw.click();
  await expect(sw).toBeChecked();
  await expect(trigger).toContainText('Generalist'); // sensible role shown while switch is on
  await dialog.getByRole('button', { name: /^Create/ }).click();
  await expect.poll(() => page.title()).toBe('created:orchestrator');
});
