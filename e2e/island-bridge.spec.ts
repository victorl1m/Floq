import { test, expect, type Page } from '@playwright/test';

// The main-window half of the island for plugin message notifications: what it publishes, and what an island intent makes it do
// (run the plugin's action through the runtime, open the plugin view at the chat, hold or dismiss). Tauri is mocked.
const message = (id: string, over: Record<string, unknown> = {}) => ({ id, userId: 'u', projectId: null, sessionId: null, sessionName: null, level: 'info', category: 'message', title: 'Marina Duarte',
  body: 'Can you send me the quote today?', action: null, createdAt: new Date().toISOString(), readAt: null,
  plugin: { id: 'waha', name: 'WhatsApp', icon: null, kind: 'message', subtitle: 'Shop', avatar: null, tag: 'shop:1', actions: [{ id: 'reply', label: 'Reply', input: { placeholder: 'Message' } }, { id: 'read', label: 'Mark read' }],
    target: { view: 'inbox', params: { chat: '5511900000001@c.us', session: 'shop' } } }, ...over });

async function boot(page: Page, query = '') {
  await page.addInitScript(() => {
    const w = window as any;
    w.__published = []; w.isTauri = true;
    const callbacks = new Map<number, (e: unknown) => void>(); const listeners: Record<string, number[]> = {}; let id = 1;
    w.__emit = (event: string, payload: unknown) => (listeners[event] ?? []).forEach(h => callbacks.get(h)?.({ event, id: 0, payload }));
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback(cb: (e: unknown) => void) { const n = id++; callbacks.set(n, cb); return n; },
      unregisterCallback() {}, convertFileSrc: (s: string) => s,
      async invoke(cmd: string, args: any) {
        if (cmd === 'plugin:event|listen') { (listeners[args.event] ??= []).push(args.handler); return id++; }
        if (cmd === 'plugin:event|unlisten') return;
        if (cmd === 'island_publish') { w.__published.push(args.snapshot); return; }
        if (cmd === 'get_desktop_preferences') return { islandEnabled: true };
      },
    };
  });
  await page.goto('/e2e/harness/island-bridge.html' + query);
  await expect(page.getByTestId('bridge')).toHaveText('ready');
  await page.waitForTimeout(300); // the first (empty) notification snapshot has landed: later frames are "new"
}
const frame = (page: Page, n: object) => page.evaluate(x => (window as any).__frame({ type: 'notification', notification: x }), n);
const intent = (page: Page, i: object) => page.evaluate(x => (window as any).__emit('island:intent', x), i);
const last = (page: Page) => page.evaluate(() => (window as any).__published.at(-1) as { items: any[]; busy: string[]; error?: string });
const client = (page: Page) => page.evaluate(() => (window as any).__client as { name: string; args: unknown[] }[]);
const items = async (page: Page) => (await last(page)).items.map(i => i.id);

test('a plugin message is published to the island with its actions; a remote avatar is dropped', async ({ page }) => {
  await boot(page);
  await frame(page, message('m1', { plugin: { ...message('x').plugin, avatar: 'https://evil.test/p.png' } }));
  await expect.poll(() => items(page)).toEqual(['m1']);
  const item = (await last(page)).items[0];
  expect(item.kind).toBe('notification');
  expect(item.notification.plugin.avatar).toBeNull();
  expect(item.notification.plugin.actions.map((a: any) => a.id)).toEqual(['reply', 'read']);
});

test('reply intent: one runtime call with the text, busy while it runs, then read and gone', async ({ page }) => {
  await boot(page);
  await frame(page, message('m1'));
  await expect.poll(() => items(page)).toEqual(['m1']);
  await intent(page, { type: 'notification-action', id: 'm1', actionId: 'reply', input: 'Sure, in an hour.' });
  await expect.poll(async () => (await last(page)).busy).toEqual(['m1']);
  // a second click while it is in flight does nothing
  await intent(page, { type: 'notification-action', id: 'm1', actionId: 'reply', input: 'again' });
  expect((await client(page)).filter(c => c.name === 'notificationAction')).toEqual([{ name: 'notificationAction', args: ['m1', 'reply', 'Sure, in an hour.'] }]);
  await page.evaluate(() => (window as any).__release());
  await expect.poll(async () => (await client(page)).some(c => c.name === 'markRead')).toBe(true);
  expect((await client(page)).find(c => c.name === 'markRead')!.args).toEqual([['m1']]);
  // the answered item is replayed briefly (the island shows "Sent"), then the queue is empty
  await expect.poll(async () => (await last(page)).busy).toEqual([]);
  await expect.poll(() => items(page), { timeout: 6000 }).toEqual([]);
});

test('only actions the notification lists are sent, and text only where the action takes it', async ({ page }) => {
  await boot(page);
  await frame(page, message('m1'));
  await expect.poll(() => items(page)).toEqual(['m1']);
  await intent(page, { type: 'notification-action', id: 'm1', actionId: 'delete-chat' });
  await intent(page, { type: 'notification-action', id: 'm1', actionId: 'reply' });
  await intent(page, { type: 'notification-action', id: 'm1', actionId: 'reply', input: '   ' });
  await intent(page, { type: 'notification-action', id: 'nope', actionId: 'read' });
  await page.waitForTimeout(200);
  expect(await client(page)).toEqual([]);
  await intent(page, { type: 'notification-action', id: 'm1', actionId: 'read', input: 'smuggled text' });
  await expect.poll(() => client(page)).toEqual([{ name: 'notificationAction', args: ['m1', 'read', undefined] }]);
});

test('a failed action keeps the notification and publishes the error', async ({ page }) => {
  await boot(page, '?fail=1');
  await frame(page, message('m1'));
  await expect.poll(() => items(page)).toEqual(['m1']);
  await intent(page, { type: 'notification-action', id: 'm1', actionId: 'reply', input: 'On my way' });
  await expect.poll(async () => (await last(page)).busy).toEqual(['m1']);
  await page.evaluate(() => (window as any).__release());
  await expect.poll(async () => (await last(page)).error).toBe('WhatsApp is not connected.');
  expect(await items(page)).toEqual(['m1']);
  expect((await client(page)).some(c => c.name === 'markRead')).toBe(false);
});

test('open intent goes to the plugin view; a message leaves on its own after 12 s unless it is held', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);
  await frame(page, message('m1'));
  await frame(page, message('m2', { title: 'Caio Prado' }));
  await expect.poll(async () => (await items(page)).sort()).toEqual(['m1', 'm2']);
  await intent(page, { type: 'notification', id: 'm1', action: 'open' });
  await expect.poll(() => page.evaluate(() => (window as any).__nav)).toEqual([['plugin', 'waha/inbox']]);
  await expect.poll(() => items(page)).toEqual(['m2']);
  // held (the reply field has focus): still there after the 12 s a message normally stays
  await intent(page, { type: 'notification', id: 'm2', action: 'hold' });
  await frame(page, message('m3', { title: 'Rafael Nunes' }));
  await expect.poll(async () => (await items(page)).sort()).toEqual(['m2', 'm3']);
  await page.waitForTimeout(8000);
  expect((await items(page)).sort()).toEqual(['m2', 'm3']); // longer than an info line (6 s)
  await expect.poll(() => items(page), { timeout: 9000 }).toEqual(['m2']);
});
