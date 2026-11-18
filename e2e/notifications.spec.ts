import { expect, test, type Page } from '@playwright/test';

const open = async (page: Page, query = '') => {
  await page.goto(`/e2e/harness/notifications.html${query}`);
  await expect(page.getByTestId('notification-bell')).toBeVisible();
  await page.waitForTimeout(150); // the initial snapshot has landed: later frames are "new"
};
const frame = (page: Page, n: object) => page.evaluate((notification) => (window as unknown as { __frame: (f: unknown) => void }).__frame({ type: 'notification', notification }), n);
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: Array<{ name: string; args: unknown[] }> }).__calls);
const note = (over: Record<string, unknown>) => ({ id: 'n1', userId: 'u1', projectId: 'p1', sessionId: 's1', sessionName: 'Build agent', level: 'info', category: 'custom', title: 'Hello there', body: null, action: null, createdAt: new Date().toISOString(), readAt: null, ...over });

test('a new notification shows as a toast and lands in the center, with an unread badge', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('notification-badge')).toHaveCount(0);
  await frame(page, note({ title: 'Build finished', level: 'success', category: 'build', body: 'All 214 tests passed' }));
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Build finished' })).toBeVisible();
  await expect(page.getByTestId('notification-badge')).toHaveText('1');
  await page.getByTestId('notification-bell').click();
  const row = page.getByTestId('notification-row').filter({ hasText: 'Build finished' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('All 214 tests passed');
  await expect(row).toContainText('build');
  await expect(row).toContainText('Build agent · Floq App');
});

test('info toasts auto-dismiss, error toasts persist', async ({ page }) => {
  await open(page);
  await frame(page, note({ id: 'i', title: 'Quick info' }));
  await frame(page, note({ id: 'e', level: 'error', title: 'Sticky failure' }));
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Sticky failure' })).toBeVisible();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Quick info' })).toBeHidden({ timeout: 9000 });
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Sticky failure' })).toBeVisible();
});

test('mark all read clears the badge and sends the read call', async ({ page }) => {
  await open(page, '?seed=1');
  await expect(page.getByTestId('notification-badge')).toHaveText('3');
  await page.getByTestId('notification-bell').click();
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByTestId('notification-badge')).toHaveCount(0);
  await expect(page.getByTestId('unread-dot')).toHaveCount(0);
  expect((await calls(page)).some((c) => c.name === 'markRead' && c.args[0] === 'all')).toBe(true);
});

test('marking one row read lowers the badge by one', async ({ page }) => {
  await open(page, '?seed=1');
  await page.getByTestId('notification-bell').click();
  await page.getByTestId('notification-row').filter({ hasText: 'v1.0.13' }).getByRole('button', { name: 'Mark as read' }).click();
  await expect(page.getByTestId('notification-badge')).toHaveText('2');
});

test('level filter narrows the list; category and project filters too; groups by day', async ({ page }) => {
  await open(page, '?seed=1');
  await page.getByTestId('notification-bell').click();
  const rows = page.getByTestId('notification-row');
  await expect(rows).toHaveCount(5);
  await expect(page.getByRole('region', { name: 'Today' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Yesterday' })).toBeVisible();
  await page.getByRole('radio', { name: 'Error' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Release build failed');
  await page.getByRole('radio', { name: 'All' }).click();
  // One Filter button opens a dropdown with Category and Project radio groups.
  await page.getByRole('button', { name: 'Filters' }).click();
  await expect(page.getByRole('menuitemradio', { name: 'All categories' })).toBeVisible();
  await page.waitForTimeout(400); // let the 100 ms fade/zoom-in finish before capturing
  await page.screenshot({ path: '.tmp/shots/notification-filter-menu.png' });
  await page.getByRole('menuitemradio', { name: 'Cost' }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Cost' })).toHaveAttribute('aria-checked', 'true');
  await expect(rows).toHaveCount(1);
  await page.getByRole('menuitemradio', { name: 'All categories' }).click();
  await page.getByRole('menuitemradio', { name: 'All projects' }).locator('xpath=following-sibling::*[1]').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Filters (1 active)' })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Usage at 80%');
});

test('action buttons fire their deep links', async ({ page }) => {
  await open(page, '?seed=1');
  await page.getByTestId('notification-bell').click();
  await page.getByRole('button', { name: 'Open Settings' }).click();
  await expect.poll(async () => (await calls(page)).find((c) => c.name === 'openSettings')?.args[0]).toBe('accounts');
  await page.getByTestId('notification-bell').click();
  await page.getByRole('button', { name: 'Open log' }).click();
  await expect.poll(async () => (await calls(page)).find((c) => c.name === 'open')?.args[0]).toBe('https://example.test/run/1');
  await page.getByTestId('notification-bell').click();
  await page.getByRole('button', { name: 'Open agent' }).click();
  await expect.poll(async () => (await calls(page)).some((c) => c.name === 'openSession')).toBe(true);
});

test('toast action button fires and marks read; clear empties the center', async ({ page }) => {
  await open(page);
  await frame(page, note({ id: 'w', level: 'warning', title: 'Limit close', action: { kind: 'settings', target: 'accounts', label: 'Open Settings' } }));
  await page.locator('[data-sonner-toast]').filter({ hasText: 'Limit close' }).getByRole('button', { name: 'Open Settings' }).click();
  await expect.poll(async () => (await calls(page)).find((c) => c.name === 'openSettings')?.args[0]).toBe('accounts');
  await expect(page.getByTestId('notification-badge')).toHaveCount(0);
  await page.getByTestId('notification-bell').click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByTestId('notification-empty')).toBeVisible();
});

for (const theme of ['light', 'dark']) {
  test(`screenshots ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page, `?seed=1&theme=${theme}`);
    await frame(page, note({ id: 'shot', level: 'warning', category: 'cost', title: 'Usage at 90% of the weekly limit', body: 'Floq will switch to your fallback at 100%.', action: { kind: 'settings', target: 'accounts', label: 'Open Settings' } }));
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `.tmp/shots/notification-toast-${theme}.png` });
    await page.getByTestId('notification-bell').click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `.tmp/shots/notification-center-${theme}.png` });
  });
}

test('center fits at 820px', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 600 });
  await open(page, '?seed=1');
  await page.getByTestId('notification-bell').click();
  const box = await page.getByTestId('notification-center').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(820);
});
