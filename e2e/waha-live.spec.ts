// An incoming message (or edit/ack/reaction) in the conversation on screen shows without reopening it, and read receipts are manual:
// opening a chat sends none, the "Mark as read" button does, and so does sending. Against the fake of the runtime (harness/waha-fake.ts).
import { expect, test, type Page } from '@playwright/test';

const WIDE = { width: 1180, height: 760 };
const MARINA = '5511987654321@c.us', GROUP = '120363041234567890@g.us';
interface Call { path: string; method: string; body?: Record<string, unknown>; session?: string }
const calls = (page: Page, p: string) => page.evaluate((x) => (window as unknown as { __calls: Call[] }).__calls.filter((c) => c.path.split('?')[0] === x), p);
const row = (page: Page, name: string | RegExp) => page.locator('.wa-row', { hasText: name });
const bubble = (page: Page, text: string | RegExp) => page.locator('.wa-msg', { hasText: text }).last();
async function open(page: Page, chat: string | RegExp, query: Record<string, string> = {}) {
  await page.setViewportSize(WIDE);
  await page.addInitScript(() => { try { localStorage.removeItem('floq.waha.account'); } catch { /* no storage */ } });
  await page.goto('/e2e/harness/waha.html?' + new URLSearchParams(query));
  await expect(page.locator('.wa-root')).toBeVisible();
  await row(page, chat).click();
  await expect(page.locator('.wa-composer')).toBeVisible();
  await expect(page.locator('.wa-msg').first()).toBeVisible();
}
const ev = <T,>(page: Page, fn: () => T) => page.evaluate(fn);

test.describe('a new message in the open conversation shows at once', () => {
  test('plain id', async ({ page }) => {
    await open(page, 'Marina Costa');
    await ev(page, () => (window as any).__fake.incoming('5511987654321@c.us', 'Plain id arrived', '5511987654321@c.us', 'Marina Costa'));
    await expect(bubble(page, 'Plain id arrived')).toBeVisible();
  });
  test('announced under another address of the same chat (ids carries the open one)', async ({ page }) => {
    await open(page, 'Marina Costa');
    await ev(page, () => (window as any).__fake.incomingVia('5511987654321@c.us', 'Alias arrived', { chatId: '5511999990000@c.us', ids: ['5511999990000@c.us', '5511987654321@c.us'] }));
    await expect(bubble(page, 'Alias arrived')).toBeVisible();
  });
  test('a group', async ({ page }) => {
    await open(page, 'Equipe Zoe');
    await ev(page, () => (window as any).__fake.incoming('120363041234567890@g.us', 'Group arrived', '5511987654321@c.us', 'Marina'));
    await expect(bubble(page, 'Group arrived')).toBeVisible();
  });
  test('found by the chat sync only (the runtime tells just the chat list)', async ({ page }) => {
    await open(page, 'Marina Costa');
    await ev(page, () => (window as any).__fake.incomingVia('5511987654321@c.us', 'Found by sync', { event: 'chats' }));
    await expect(bubble(page, 'Found by sync')).toBeVisible();
  });
  test('the second account, while typing', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await page.addInitScript(() => { try { localStorage.removeItem('floq.waha.account'); } catch { /* no storage */ } });
    await page.goto('/e2e/harness/waha.html?accounts=2');
    await expect(page.locator('.wa-root')).toBeVisible();
    await page.getByRole('button', { name: /^WhatsApp account:/ }).click();
    await page.getByRole('menuitemradio').nth(1).click();
    await row(page, 'Clínica Bem Viver').click();
    await expect(page.locator('.wa-composer')).toBeVisible();
    await page.locator('.wa-cfield textarea').fill('typing a reply');
    await ev(page, () => (window as any).__fake.of('lucy').incoming('5534991112233@c.us', 'Second account arrived', '5534991112233@c.us', 'Clínica'));
    await expect(bubble(page, 'Second account arrived')).toBeVisible();
    await expect(page.locator('.wa-cfield textarea')).toHaveValue('typing a reply');
  });
});

test.describe('read receipts are manual', () => {
  test('opening a chat sends none; the button shows with unread messages, a click sends and hides it', async ({ page }) => {
    await open(page, 'Marina Costa');
    await ev(page, () => (window as any).__fake.incoming('5511987654321@c.us', 'One more', '5511987654321@c.us', 'Marina Costa'));
    await expect(bubble(page, 'One more')).toBeVisible();
    const reads = await calls(page, '/read');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.body?.local === true)).toBe(true); // Floq's own badge only
    const button = page.getByRole('button', { name: 'Mark as read' });
    await expect(button).toBeVisible();
    await button.hover();
    await expect(page.getByRole('tooltip').first()).toContainText('Send read receipt');
    await button.click();
    await expect(button).toBeHidden();
    const after = await calls(page, '/read');
    expect(after.filter((c) => c.body?.local !== true)).toHaveLength(1);
    expect(after.at(-1)?.body?.chatId).toBe(MARINA);
    // a newer message brings it back
    await ev(page, () => (window as any).__fake.incoming('5511987654321@c.us', 'And another', '5511987654321@c.us', 'Marina Costa'));
    await expect(button).toBeVisible();
  });
  test('sending hides it', async ({ page }) => {
    await open(page, 'Marina Costa');
    await ev(page, () => (window as any).__fake.incoming('5511987654321@c.us', 'Please answer', '5511987654321@c.us', 'Marina Costa'));
    const button = page.getByRole('button', { name: 'Mark as read' });
    await expect(button).toBeVisible();
    await page.locator('.wa-cfield textarea').fill('On it');
    await page.keyboard.press('Enter');
    await expect(bubble(page, 'On it')).toBeVisible();
    await expect(button).toBeHidden();
    expect((await calls(page, '/read')).filter((c) => c.body?.local !== true)).toHaveLength(0); // the runtime reads the chat when it sends
  });
  test('the account menu has the automatic-receipts setting, off by default', async ({ page }) => {
    await open(page, 'Marina Costa');
    await page.getByRole('button', { name: /^WhatsApp account:/ }).click();
    await expect(page.getByRole('menuitem', { name: /Send read receipts automatically: Off/ })).toBeVisible();
    await page.getByRole('menuitem', { name: /Send read receipts automatically/ }).click();
    expect((await calls(page, '/receipts/settings')).find((c) => c.method === 'POST')?.body).toEqual({ auto: true });
  });
});
