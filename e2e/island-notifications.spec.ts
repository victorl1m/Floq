import { test, expect, type Page } from '@playwright/test';
import { approval, boot, snapshot } from './island-helpers';

const note = (id: string, level: string, extra: object = {}) => ({ kind: 'notification', id, createdAt: '2026-01-01T00:00:00Z', notification: {
  id, userId: 'u', projectId: null, sessionId: null, sessionName: 'builder', level, category: 'build', title: `Build ${level}`, body: 'All 214 checks ran in 38s.',
  action: null, createdAt: '2026-01-01T00:00:00Z', readAt: null, ...extra } }) as any;
const calls = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'island_intent').map((c: any) => c.args.intent));
const open = async (page: Page) => { await page.locator('.island').hover(); await expect(page.locator('.island.expanded')).toBeVisible(); await page.waitForTimeout(500); };

for (const level of ['info', 'success', 'warning', 'error']) {
  test(`${level} notification renders with its level styling`, async ({ page }) => {
    await boot(page, { items: [note('n1', level)] });
    await expect(page.locator('.island-pill-title')).toHaveText(`Build ${level}`);
    await open(page);
    const card = page.locator('.island-notification');
    await expect(card).toHaveAttribute('data-level', level);
    await expect(card.locator('.island-notification-title')).toHaveText(`Build ${level}`);
    await expect(card.locator('.island-notification-body')).toContainText('214 checks');
    const color = await card.locator('.island-notification-kind').evaluate(e => getComputedStyle(e).color);
    const expected = { info: 'rgb(56, 189, 248)', success: 'rgb(52, 211, 153)', warning: 'rgb(251, 191, 36)', error: 'rgb(248, 113, 113)' }[level];
    expect(color).toBe(expected);
  });
}

test('dismiss emits a dismiss intent and hides the card locally', async ({ page }) => {
  await boot(page, { items: [note('n1', 'warning')] });
  await open(page);
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  expect(await calls(page)).toContainEqual({ type: 'notification', id: 'n1', action: 'dismiss' });
  await expect(page.locator('.island-notification')).toHaveCount(0);
});

test('clicking the item or its action emits an open intent', async ({ page }) => {
  await boot(page, { items: [note('n1', 'success', { action: { kind: 'canvas', target: 'x', label: 'Open canvas' } })] });
  await open(page);
  await page.getByRole('button', { name: 'Open canvas' }).click();
  expect(await calls(page)).toContainEqual({ type: 'notification', id: 'n1', action: 'open' });
  await boot(page, { items: [note('n2', 'info')] });
  await open(page);
  await page.locator('.island-notification-main').click();
  expect(await calls(page)).toContainEqual({ type: 'notification', id: 'n2', action: 'open' });
});

test('an approval outranks a notification (shown first, normal waiting pill)', async ({ page }) => {
  await boot(page, { items: [approval('a1'), note('n1', 'error')] });
  await expect(page.locator('.island-count')).toHaveText('2');
  await open(page);
  await expect(page.locator('.island-notification')).toHaveCount(0);
  await expect(page.locator('.island-title-command')).toHaveText('git push origin main');
  // The notification is the next card.
  await page.getByRole('button', { name: 'Next request' }).click();
  await expect(page.locator('.island-notification')).toHaveAttribute('data-level', 'error');
});

test('a snapshot update removes a notification the main window auto-dismissed', async ({ page }) => {
  await boot(page, { items: [note('n1', 'info')] });
  await page.evaluate(s => (window as any).__emit('island:snapshot', s), { ...snapshot([], 2), revision: 2 });
  await expect(page.locator('.island')).toHaveCount(0, { timeout: 3000 });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`screenshot ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await boot(page, { items: [note('n1', 'error', { title: 'Release build failed', body: 'cargo test exited with code 101 in island.rs', action: { kind: 'agent', target: 'x', label: 'Open agent' } })] });
    await page.screenshot({ path: `.tmp/shots/island-notification-pill-${scheme}.png` });
    await open(page);
    await page.screenshot({ path: `.tmp/shots/island-notification-${scheme}.png` });
  });
}
