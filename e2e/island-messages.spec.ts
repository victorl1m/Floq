import { test, expect, type Page } from '@playwright/test';
import { approval, boot, snapshot } from './island-helpers';

// A plugin message notification (WhatsApp through ctx.notify) on the island: render, inline reply, mark read, open chat, dismiss.
// Fixture people and text are invented. Screenshots go to WAHA_SHOTS (default .tmp/shots).
const SHOTS = process.env.WAHA_SHOTS || '.tmp/shots';
// 1x1 png, stretched by the avatar: enough to prove an inline image is shown.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';
const message = (id: string, extra: Record<string, unknown> = {}, plugin: Record<string, unknown> = {}) => ({ kind: 'notification', id, createdAt: '2026-01-01T00:00:00Z', notification: {
  id, userId: 'u', projectId: null, sessionId: null, sessionName: null, level: 'info', category: 'message', title: 'Marina Duarte', body: 'Can you send me the quote for the mugs today?',
  action: null, createdAt: '2026-01-01T00:00:00Z', readAt: null,
  plugin: { id: 'waha', name: 'WhatsApp', icon: 'IconBrandWhatsapp', kind: 'message', subtitle: 'Shop', avatar: PNG, tag: 'shop:1',
    actions: [{ id: 'reply', label: 'Reply', input: { placeholder: 'Reply to Marina' } }, { id: 'read', label: 'Mark read' }],
    target: { view: 'inbox', params: { chat: '5511900000001@c.us', session: 'shop' } }, ...plugin },
  ...extra } }) as any;
const intents = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'island_intent').map((c: any) => c.args.intent));
const emit = (page: Page, s: unknown) => page.evaluate(x => (window as any).__emit('island:snapshot', x), s);
const open = async (page: Page) => { await page.locator('.island').hover(); await expect(page.locator('.island.expanded')).toBeVisible(); await page.waitForTimeout(500); };

test('a message shows the sender, the account and a preview; the pill carries the avatar', async ({ page }) => {
  await boot(page, { items: [message('m1')] });
  await expect(page.locator('.island-pill-title')).toHaveText('Marina Duarte');
  await expect(page.locator('.island-header .island-avatar img')).toHaveAttribute('src', PNG);
  await open(page);
  const card = page.locator('.island-message');
  await expect(card.locator('.island-notification-kind')).toHaveText('WhatsApp · Shop');
  await expect(card.locator('.island-notification-title')).toHaveText('Marina Duarte');
  await expect(card.locator('.island-notification-body')).toContainText('quote for the mugs');
  await expect(card.locator('.island-avatar img')).toBeVisible();
  await expect(card.getByRole('textbox', { name: 'Reply to Marina Duarte' })).toHaveAttribute('placeholder', 'Reply to Marina');
  await expect(card.getByRole('button', { name: 'Mark read' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Open chat' })).toBeVisible();
  // Nothing is cut off: the card fits its window.
  const box = await card.boundingBox(); const shell = await page.locator('.island').boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(shell!.y + shell!.height + 1);
});

test('no avatar: initials; a remote or svg avatar is never loaded', async ({ page }) => {
  const requests: string[] = []; page.on('request', r => { if (/evil\.test/.test(r.url())) requests.push(r.url()); });
  await boot(page, { items: [message('m1', {}, { avatar: null })] });
  await open(page);
  await expect(page.locator('.island-message .island-avatar')).toHaveText('MD');
  await boot(page, { items: [message('m2', { title: 'Family group' }, { avatar: 'https://evil.test/pixel.png', subtitle: 'Personal · Family group' })] });
  await open(page);
  await expect(page.locator('.island-message .island-avatar img')).toHaveCount(0);
  await expect(page.locator('.island-message .island-avatar')).toHaveText('FG');
  expect(requests).toEqual([]);
});

test('inline reply: focus holds the card, Enter sends the text, the island confirms once the main window is done', async ({ page }) => {
  await boot(page, { items: [message('m1')] });
  await open(page);
  const field = page.getByRole('textbox', { name: 'Reply to Marina Duarte' });
  const sendButton = page.getByRole('button', { name: 'Send reply' });
  await expect(sendButton).toBeDisabled();
  await field.click();
  expect(await intents(page)).toContainEqual({ type: 'notification', id: 'm1', action: 'hold' });
  await field.fill('   ');
  await expect(sendButton).toBeDisabled();
  await field.fill('Sure, in an hour.');
  // The pointer may leave: a focused field keeps the island open.
  await page.mouse.move(220, 580);
  await page.waitForTimeout(500);
  await expect(page.locator('.island.expanded')).toBeVisible();
  await field.press('Enter');
  expect(await intents(page)).toContainEqual({ type: 'notification-action', id: 'm1', actionId: 'reply', input: 'Sure, in an hour.' });
  await expect(field).toBeDisabled();
  // Main window: busy while the plugin sends, then the notification is gone.
  await emit(page, { ...snapshot([message('m1')], 2), busy: ['m1'] });
  await emit(page, snapshot([], 3));
  await expect(page.locator('.island-result-label')).toHaveText('Sent');
  await expect(page.locator('.island-result-sub')).toHaveText('To Marina Duarte');
  await page.screenshot({ path: `${SHOTS}/waha-island-reply-sent.png` });
  await expect(page.locator('.island')).toHaveCount(0, { timeout: 6000 });
  // exactly one send
  expect((await intents(page)).filter((i: any) => i.type === 'notification-action')).toHaveLength(1);
});

test('a failed reply keeps the card and the typed text and shows the error', async ({ page }) => {
  await boot(page, { items: [message('m1')] });
  await open(page);
  const field = page.getByRole('textbox', { name: 'Reply to Marina Duarte' });
  await field.fill('On my way');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await emit(page, { ...snapshot([message('m1')], 2), busy: ['m1'] });
  await emit(page, { ...snapshot([message('m1')], 3), error: 'WhatsApp is not connected.' });
  await expect(page.locator('.island-error')).toHaveText('WhatsApp is not connected.');
  await expect(field).toHaveValue('On my way');
  await expect(field).toBeEnabled();
  await expect(page.locator('.island-result-label')).toHaveCount(0);
});

test('mark read runs the plugin action; open chat and the card itself open the chat; dismiss only hides', async ({ page }) => {
  await boot(page, { items: [message('m1')] });
  await open(page);
  await page.getByRole('button', { name: 'Mark read' }).click();
  expect(await intents(page)).toContainEqual({ type: 'notification-action', id: 'm1', actionId: 'read' });
  await emit(page, { ...snapshot([message('m1')], 2), busy: ['m1'] });
  await emit(page, snapshot([], 3));
  await expect(page.locator('.island-result-label')).toHaveText('Done');

  await boot(page, { items: [message('m2')] });
  await open(page);
  await page.getByRole('button', { name: 'Open chat' }).click();
  expect(await intents(page)).toContainEqual({ type: 'notification', id: 'm2', action: 'open' });
  await expect(page.locator('.island-message')).toHaveCount(0);

  await boot(page, { items: [message('m3')] });
  await open(page);
  await page.locator('.island-notification-main').click();
  expect(await intents(page)).toContainEqual({ type: 'notification', id: 'm3', action: 'open' });

  await boot(page, { items: [message('m4')] });
  await open(page);
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  expect(await intents(page)).toContainEqual({ type: 'notification', id: 'm4', action: 'dismiss' });
  expect((await intents(page)).some((i: any) => i.type === 'notification-action')).toBe(false);
});

test('a message without actions or target is a plain card; an approval still comes first', async ({ page }) => {
  await boot(page, { items: [approval('a1'), message('m1', {}, { actions: [], target: null })] });
  await expect(page.locator('.island-count')).toHaveText('2');
  await open(page);
  await expect(page.locator('.island-title-command')).toBeVisible();
  await page.getByRole('button', { name: 'Next request' }).click();
  const card = page.locator('.island-message');
  await expect(card).toBeVisible();
  await expect(card.locator('.island-reply')).toHaveCount(0);
  await expect(card.locator('.island-message-actions')).toHaveCount(0);
  await expect(card.locator('.island-notification-main')).toBeDisabled();
});

test('typed text survives switching between two messages', async ({ page }) => {
  await boot(page, { items: [message('m1'), message('m2', { title: 'Caio Prado', body: 'Photo' }, { subtitle: 'Personal', avatar: null })] });
  await open(page);
  await page.getByRole('textbox', { name: 'Reply to Marina Duarte' }).fill('draft one');
  await page.getByRole('button', { name: 'Next request' }).click();
  await expect(page.getByRole('textbox', { name: 'Reply to Caio Prado' })).toHaveValue('');
  await page.getByRole('button', { name: 'Previous request' }).click();
  await expect(page.getByRole('textbox', { name: 'Reply to Marina Duarte' })).toHaveValue('draft one');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`screenshots ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await boot(page, { items: [message('m1')] });
    await page.screenshot({ path: `${SHOTS}/waha-island-pill-${scheme}.png` });
    await open(page);
    await page.screenshot({ path: `${SHOTS}/waha-island-message-${scheme}.png` });
    await page.getByRole('textbox', { name: 'Reply to Marina Duarte' }).fill('Sure, sending it in an hour.');
    await page.screenshot({ path: `${SHOTS}/waha-island-reply-${scheme}.png` });
    await boot(page, { items: [message('g1', { title: 'Rafael Nunes', body: 'Photo' }, { avatar: null, subtitle: 'Personal · Sunday football', actions: [{ id: 'reply', label: 'Reply', input: { placeholder: 'Message' } }, { id: 'read', label: 'Mark read' }] }), message('m1')] });
    await open(page);
    await page.screenshot({ path: `${SHOTS}/waha-island-group-${scheme}.png` });
  });
}
