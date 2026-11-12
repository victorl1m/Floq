import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 980, height: 500 } });

test('agents get different, stable robot avatars with a provider badge; the setting falls back to logos', async ({ page }) => {
  await page.goto('/e2e/harness/agent-avatars.html');
  const avatars = page.locator('#avatars [data-agent-avatar] img');
  await expect(avatars).toHaveCount(3);
  const srcs = await avatars.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src));
  expect(new Set(srcs).size).toBe(3);
  expect(srcs[0]).toMatch(/^data:image\/svg\+xml/);
  await page.screenshot({ path: '.tmp/shots/agent-avatars.png' });
  await page.reload();
  await expect(avatars).toHaveCount(3);
  expect(await avatars.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src))).toEqual(srcs);
  await expect(page.locator('#avatars [data-agent-avatar] svg').first()).toBeVisible();
  await page.evaluate(() => { localStorage.setItem('floq.robotAvatars', 'off'); window.dispatchEvent(new Event('floq:robot-avatars')); });
  await expect(page.locator('[data-agent-avatar]')).toHaveCount(0);
});

test('dark theme avatars render', async ({ page }) => {
  await page.goto('/e2e/harness/agent-avatars.html?theme=dark');
  await expect(page.locator('#avatars [data-agent-avatar] img')).toHaveCount(3);
  await page.screenshot({ path: '.tmp/shots/agent-avatars-dark.png' });
});

test('card header: state label, role chips inside pills, no dot, link button or in-context chip', async ({ page }) => {
  await page.goto('/e2e/harness/agent-avatars.html');
  await expect(page.getByTestId('agent-state')).toHaveText(['Running', 'Sleeping', 'Failed']);
  await expect(page.getByText('Orchestrator', { exact: true })).toBeVisible();
  await expect(page.getByText('Implementer', { exact: true })).toBeVisible();
  await expect(page.getByTestId('in-context-badge')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Link .* to another agent$/ })).toHaveCount(0);
});
