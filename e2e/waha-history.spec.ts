// WAHA plugin 3.2: history import and contacts. The note on the QR screens, the progress bar over the chat list (progress, cancel, done, failed + retry),
// "Import history" in the account menu, and the Contacts list (search, open the chat, contact info, Sync now). Mounted from the built-in WhatsApp UI (src/plugins/whatsapp)
// against the fake of its routes (harness/waha-fake.ts: ?import=running|done|failed, ?willImport=0, ?historyError=text; __fake.of(session).importTick(n)).
// Screenshots go to the Artifacts folder: waha-history-<variant>-<name>.png and waha-history-contacts-<variant>.png. WAHA_SHOTS=dir
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const shots = process.env.WAHA_SHOTS ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';

interface Call { path: string; method: string; body?: Record<string, unknown>; session?: string }
const WIDE = { width: 1180, height: 760 }, NARROW = { width: 390, height: 760 };
const VARIANTS = [
  { name: 'light-wide', theme: 'light', size: WIDE, q: {} },
  { name: 'dark-wide', theme: 'dark', size: WIDE, q: {} },
  { name: 'light-narrow', theme: 'light', size: NARROW, q: {} },
  { name: 'dark-narrow', theme: 'dark', size: NARROW, q: {} },
  { name: 'light-solid', theme: 'light', size: WIDE, q: { material: 'solid', frame: '1' } },
  { name: 'dark-acrylic', theme: 'dark', size: WIDE, q: { native: 'acrylic', frame: '1' } },
];
type V = (typeof VARIANTS)[number];
async function open(page: Page, v: V, query: Record<string, string> = {}) {
  await page.setViewportSize(v.size);
  await page.addInitScript(() => { try { localStorage.removeItem('floq.waha.account'); } catch { /* no storage */ } });
  await page.goto('/e2e/harness/waha.html?' + new URLSearchParams({ ...v.q, ...query, ...(v.theme === 'dark' ? { theme: 'dark' } : {}) }));
  await expect(page.locator('.wa-root')).toBeVisible();
}
async function shot(page: Page, v: V, name: string) {
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shots, `waha-history-${name.startsWith('contacts') ? name.replace('contacts', 'contacts-' + v.name).replace(/-$/, '') : v.name + '-' + name}.png`) });
}
const calls = (page: Page, p: string) => page.evaluate((x) => (window as unknown as { __calls: Call[] }).__calls.filter((c) => c.path.split('?')[0] === x), p);
const tick = (page: Page, n: number, session = 'default') => page.evaluate(([n, s]) => (window as unknown as { __fake: { of(s: string): { importTick(n: number): void } } }).__fake.of(s as string).importTick(n as number), [n, session]);
const emit = (page: Page, name: string, data: object) => page.evaluate(([n, d]) => (window as unknown as { __fake: { emit(n: string, d: unknown): void } }).__fake.emit(n as string, d), [name, data]);
/** A phone that is not linked: the list shows the reconnect bar, "Link again" opens the QR screen. */
async function openQr(page: Page, v: V, query: Record<string, string> = {}) {
  await open(page, v, { state: 'qr', ...query });
  await page.getByRole('button', { name: 'Link again' }).click();
  await expect(page.getByRole('heading', { name: 'Link WhatsApp to Floq' })).toBeVisible();
}
const accountButton = (page: Page) => page.getByRole('button', { name: /^WhatsApp account:/ });
const bar = (page: Page) => page.locator('.wa-hbar');
async function openMenu(page: Page) { await accountButton(page).click(); await expect(page.getByRole('menu')).toBeVisible(); }
/** The list header (the narrow layout shows the list first). */
async function toList(page: Page) { await expect(page.locator('.wa-list-pane')).toBeVisible(); }
const noOverflow = (page: Page, sel: string) => page.locator(sel).first().evaluate((e) => e.scrollWidth <= e.clientWidth + 1);

for (const v of VARIANTS) {
  test.describe(v.name, () => {
    test('QR screens: Floq imports after the scan; a history error says only new messages will show', async ({ page }) => {
      await openQr(page, v);
      await expect(page.getByRole('note')).toHaveText('Floq will import your chats and history after you scan.');
      expect(await noOverflow(page, '.wa-hnote')).toBe(true);
      await page.locator('.wa-hnote').scrollIntoViewIfNeeded();
      await shot(page, v, 'qr-note');
      // The pairing form carries it too.
      await page.getByRole('button', { name: /Link with phone number instead/ }).click();
      await expect(page.getByRole('note')).toContainText('Floq will import your chats');
      await page.getByRole('button', { name: /Link with QR code instead/ }).click();

      await openQr(page, v, { historyError: 'The engine does not keep history' });
      await expect(page.getByRole('note')).toHaveText('WAHA could not turn on history for this session: The engine does not keep history. You can still link it; only new messages will show.');
      await expect(page.getByRole('note')).not.toContainText('Floq will import');
      await page.locator('.wa-hnote').scrollIntoViewIfNeeded();
      await shot(page, v, 'qr-error');

      await openQr(page, v, { willImport: '0' });
      await expect(page.getByRole('heading', { name: 'Link WhatsApp to Floq' })).toBeVisible();
      await expect(page.getByRole('note')).toHaveCount(0);
    });

    test('Add account > Link a new WhatsApp shows the note under the QR code', async ({ page }) => {
      await open(page, v, { accounts: '2' });
      await toList(page);
      await openMenu(page);
      await page.getByRole('menuitem', { name: 'Add account' }).click();
      await page.getByRole('button', { name: /Link a new WhatsApp/ }).click();
      await page.getByRole('button', { name: 'Show QR code' }).click();
      const dlg = page.getByRole('dialog');
      await expect(dlg.getByRole('note')).toHaveText('Floq will import your chats and history after you scan.');
      await expect(dlg.getByRole('img', { name: /QR code/ })).toBeVisible();
      expect(await noOverflow(page, '[role=dialog] .wa-hnote')).toBe(true);
      await shot(page, v, 'add-account');
    });

    test('progress bar: reads 34 of 120 chats, follows "history" events, Cancel stops it', async ({ page }) => {
      await open(page, v, { import: 'running' });
      await toList(page);
      await expect(bar(page)).toContainText('Importing history… 34 of 120 chats');
      const track = bar(page).getByRole('progressbar');
      await expect(track).toHaveAttribute('aria-valuenow', '28');
      expect(await calls(page, '/history')).not.toHaveLength(0);
      await shot(page, v, 'progress');

      await tick(page, 40);
      await expect(bar(page)).toContainText('74 of 120 chats');
      await expect(track).toHaveAttribute('aria-valuenow', '62');
      await emit(page, 'history', { state: 'running', phase: 'contacts', chatsTotal: 0, chatsDone: 0, messages: 0, contacts: 12, everRan: true, limits: { perChat: 500, total: 50000 } });
      await expect(bar(page)).toContainText('Importing contacts…');
      await emit(page, 'history', { state: 'running', phase: 'chats', chatsTotal: 0, chatsDone: 0, messages: 0, contacts: 86, everRan: true, limits: { perChat: 500, total: 50000 } });
      await expect(bar(page)).toContainText('Reading your chats…');
      await shot(page, v, 'progress-reading');
      expect(await noOverflow(page, '.wa-hbar-text')).toBe(true);

      await tick(page, 0);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(bar(page)).toHaveCount(0);
      expect(await calls(page, '/history/cancel')).toHaveLength(1);
      // A chat list that is still there and usable.
      await expect(page.getByText('Marina Costa').first()).toBeVisible();
    });

    test('progress bar: when the import finishes it says "History imported", then goes away, and the chats are read again', async ({ page }) => {
      await open(page, v, { import: 'running' });
      await toList(page);
      await expect(bar(page)).toContainText('34 of 120');
      const before = (await calls(page, '/chats')).length;
      await tick(page, 200);
      await expect(bar(page)).toHaveText('History imported');
      await shot(page, v, 'imported');
      await expect.poll(async () => (await calls(page, '/chats')).length).toBeGreaterThan(before);
      await expect(bar(page)).toHaveCount(0, { timeout: 8000 });
    });

    test('a failed import shows the error and Retry starts it again', async ({ page }) => {
      await open(page, v, { import: 'failed' });
      await toList(page);
      await expect(bar(page)).toContainText('Import failed');
      await expect(bar(page)).toContainText('WAHA stopped answering while the chats were being read.');
      expect(await noOverflow(page, '.wa-hbar-text')).toBe(true);
      await shot(page, v, 'failed');
      await bar(page).getByRole('button', { name: 'Retry' }).click();
      await expect(bar(page)).toContainText('Importing history… 34 of 120 chats');
      expect(await calls(page, '/history/start')).toHaveLength(1);
    });

    test('account menu: Import history, progress with Cancel import, then Import history again', async ({ page }) => {
      await open(page, v, { accounts: '3' });
      await toList(page);
      await expect(bar(page)).toHaveCount(0);
      await openMenu(page);
      const menu = page.getByRole('menu');
      await shot(page, v, 'menu-import');
      await menu.getByRole('menuitem', { name: 'Import history', exact: true }).click();
      await expect(bar(page)).toContainText('34 of 120');
      const started = await calls(page, '/history/start');
      expect(started).toHaveLength(1);
      expect(started[0].session).toBe('default');

      await openMenu(page);
      await expect(menu.getByRole('status')).toContainText('Importing history… 34 of 120 chats');
      await expect(menu.getByRole('menuitemradio').first()).toContainText('Importing 34 of 120');
      await expect(menu.getByRole('menuitem', { name: 'Import history' })).toHaveCount(0);
      await shot(page, v, 'menu-running');
      await menu.getByRole('menuitem', { name: 'Cancel import' }).click();
      await expect(bar(page)).toHaveCount(0);
      expect(await calls(page, '/history/cancel')).toHaveLength(1);

      await openMenu(page);
      await expect(menu.getByRole('menuitem', { name: 'Import history again' })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Import history', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');

      // Another account's import shows in its row, and switching to it loads its own state.
      await page.evaluate(async () => { const f = (window as unknown as { __fake: { fetch(p: string, i: unknown): Promise<unknown>; emit(n: string, d: unknown): void } }).__fake; await f.fetch('/history/start?session=lucy', { method: 'POST' }); f.emit('accounts', {}); });
      await openMenu(page);
      await expect(menu.getByRole('menuitemradio').nth(1)).toContainText('Importing 34 of 120');
      await menu.getByRole('menuitemradio').nth(1).click();
      await expect(bar(page)).toContainText('34 of 120');
      expect((await calls(page, '/history')).some((c) => c.session === 'lucy' || c.path.includes('session=lucy'))).toBe(true);
    });

    test('account menu after a finished import offers Import history again', async ({ page }) => {
      await open(page, v, { import: 'done' });
      await toList(page);
      await expect(bar(page)).toHaveCount(0);
      await openMenu(page);
      await expect(page.getByRole('menuitem', { name: 'Import history again' })).toBeVisible();
    });

    test('Contacts: saved names first, business badge, search, open the chat, contact info, Sync now', async ({ page }) => {
      await open(page, v);
      await toList(page);
      await openMenu(page);
      await page.getByRole('menuitem', { name: 'Contacts' }).click();
      const view = page.getByRole('region', { name: 'Contacts' });
      await expect(view).toBeVisible();
      await expect(view.getByText('Adriana Lopes')).toBeVisible();
      await expect(view.locator('.wa-csync')).toContainText('36 contacts · Synced 2 h ago');
      await expect(view.locator('.wa-cbadge').first()).toHaveText('Business');
      await expect(view.locator('.wa-crow')).toHaveCount(36);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // the account button's tooltip stays while it has the focus
      const names = await view.locator('.wa-crow-t b span').allTextContents();
      expect(names.indexOf('Adriana Lopes')).toBeLessThan(names.indexOf('Estúdio Aurora Embalagens'));
      expect(names.indexOf('Nicole Brandão')).toBeLessThan(names.length - 4);
      expect(await noOverflow(page, '.wa-clist')).toBe(true);
      await shot(page, v, 'contacts');

      await view.getByRole('searchbox').fill('bruno');
      await expect(view.locator('.wa-crow')).toHaveCount(1);
      await expect(view.locator('.wa-crow')).toContainText('Bruno Cardoso');
      await view.getByRole('searchbox').fill('zzz');
      await expect(view).toContainText('No contacts match “zzz”.');
      await view.getByRole('searchbox').fill('');
      await expect(view.locator('.wa-crow')).toHaveCount(36);
      const asked = await calls(page, '/contacts');
      expect(asked.some((c) => c.path.includes('q=bruno') && c.path.includes('offset=0'))).toBe(true);

      await view.getByRole('button', { name: 'Sync now' }).click();
      await expect(view.locator('.wa-csync')).toContainText('Syncing…');
      await expect(view.locator('.wa-csync')).toContainText('Synced just now');
      expect(await calls(page, '/contacts/sync')).toHaveLength(1);
      await shot(page, v, 'contacts-synced');

      // Click a person: the chat opens.
      await view.getByRole('button', { name: 'Open chat with Bruno Cardoso' }).click();
      await expect(page.getByRole('region', { name: 'Contacts' })).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: /message/i }).first()).toBeVisible();
      await expect(page.locator('.wa-chat-head, .wa-cv-head').first()).toContainText('Bruno Cardoso');

      // The info button opens the contact info panel of that person.
      if (v.size.width < 500) await page.getByRole('button', { name: 'Back' }).first().click();
      await openMenu(page);
      await page.getByRole('menuitem', { name: 'Contacts' }).click();
      await page.getByRole('button', { name: 'Contact info: Camila Duarte' }).click();
      await expect(page.getByRole('complementary', { name: 'Contact info' })).toBeVisible();
      await expect(page.getByRole('complementary', { name: 'Contact info' })).toContainText('Camila Duarte');
      await shot(page, v, 'contacts-info');
    });
  });
}
