// WAHA plugin 3.1: several WhatsApp accounts in one inbox. The account switcher in the list header, "Add account" (link a new WhatsApp by QR, or
// attach a session that already runs in WAHA), per-account actions, "Remove from Floq", and that every request names the account it is for.
// Mounted from the plugin's BUILT package against the fake of its routes (harness/waha-fake.ts, ?accounts=N).
// Screenshots go to the Artifacts folder: waha-accounts-<theme>-<name>.png.   WAHA_PLUGIN_DIR=checkout (after npm run build there)   WAHA_SHOTS=dir
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const pluginDir = process.env.WAHA_PLUGIN_DIR ?? path.resolve(process.env.HOME ?? '.', 'work/floq-plugin-waha');
const dist = path.join(pluginDir, 'dist');
const pkgFile = existsSync(dist) ? readdirSync(dist).find((f) => /^waha-.*\.floqpkg\.json$/.test(f)) : undefined;
const shots = process.env.WAHA_SHOTS ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
test.skip(!pkgFile, 'no built WAHA plugin package: set WAHA_PLUGIN_DIR and run npm run build there');

interface Call { path: string; method: string; body?: Record<string, unknown>; session?: string }
const WIDE = { width: 1180, height: 760 }, NARROW = { width: 390, height: 760 };
async function open(page: Page, theme: string, query: Record<string, string> = {}, size = WIDE) {
  await page.setViewportSize(size);
  await page.route('**/__waha/pkg.json', (route) => route.fulfill({ contentType: 'application/json', body: readFileSync(path.join(dist, pkgFile!), 'utf8') }));
  await page.addInitScript(() => { try { localStorage.removeItem('floq.waha.account'); } catch { /* no storage */ } });
  await page.goto('/e2e/harness/waha.html?' + new URLSearchParams({ accounts: '3', ...query, ...(theme === 'dark' ? { theme: 'dark' } : {}) }));
  await expect(page.locator('.wa-root')).toBeVisible();
}
async function shot(page: Page, theme: string, name: string) {
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shots, `waha-accounts-${theme}-${name}.png`) });
}
const calls = (page: Page, p: string) => page.evaluate((x) => (window as unknown as { __calls: Call[] }).__calls.filter((c) => c.path.split('?')[0] === x), p);
const fake = (page: Page, js: string) => page.evaluate(js);
const accountButton = (page: Page) => page.getByRole('button', { name: /^WhatsApp account:/ });
const menu = (page: Page) => page.getByRole('menu');
const rows = (page: Page) => menu(page).getByRole('menuitemradio');
const noOverflow = (page: Page, sel: string) => page.locator(sel).evaluate((e) => e.scrollWidth <= e.clientWidth + 1);
/** Nothing of the element is cut off by the viewport. */
async function inView(page: Page, sel: string) {
  const b = (await page.locator(sel).boundingBox())!, v = page.viewportSize()!;
  expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(v.width + 1); expect(b.y + b.height).toBeLessThanOrEqual(v.height + 1);
}

for (const theme of ['light', 'dark']) {
  for (const [sizeName, size] of [['wide', WIDE], ['narrow', NARROW]] as const) {
    test.describe(`${theme} ${sizeName}`, () => {
      const tag = (s: string) => `${s}${sizeName === 'narrow' ? '-narrow' : ''}`;

      test('switcher: every account with name, number, state and unread; the active one is checked; switching shows that account only', async ({ page }) => {
        await open(page, theme, {}, size);
        await expect(page.getByText('Marina Costa').first()).toBeVisible();
        // Unread in the other accounts shows on the avatar: Lucy has 2 chats, Loja 2.
        await expect(accountButton(page)).toHaveAccessibleName(/Victor, Connected\. 4 unread in other accounts/);
        await accountButton(page).click();
        await expect(rows(page)).toHaveCount(3);
        await expect(rows(page).nth(0)).toHaveAttribute('aria-checked', 'true');
        await expect(rows(page).nth(0)).toContainText('Victor');
        await expect(rows(page).nth(0)).toContainText('+55 34 98888-0000');
        await expect(rows(page).nth(1)).toContainText('SolutionsLucy');
        await expect(rows(page).nth(1)).toContainText('+55 34 98811-0779');
        await expect(rows(page).nth(1)).toContainText('Connected');
        await expect(rows(page).nth(1).locator('.wa-arow-n')).toHaveText('2');
        await expect(rows(page).nth(2)).toContainText('Loja');
        await expect(rows(page).nth(2)).toContainText('Stopped');
        await expect(menu(page).getByRole('menuitem', { name: 'Add account' })).toBeVisible();
        await expect(menu(page).getByRole('menuitem', { name: 'Remove from Floq' })).toBeVisible();
        await expect(menu(page).getByRole('menuitem', { name: 'Log out' })).toBeVisible();
        await inView(page, '[role=menu]');
        expect(await noOverflow(page, '[role=menu]')).toBe(true);
        await shot(page, theme, tag('switcher'));

        await rows(page).nth(1).click();
        await expect(page.getByText('Clínica Bem Viver')).toBeVisible();
        await expect(page.getByText('Marina Costa')).toHaveCount(0);
        await expect(accountButton(page)).toHaveAccessibleName(/SolutionsLucy, Connected/);
        const chats = await calls(page, '/chats');
        expect(chats.at(-1)!.session).toBe('lucy');

        // A chat of this account: the header says whose it is, and the reply leaves from it.
        await page.getByRole('button', { name: /Clínica Bem Viver/ }).first().click();
        await expect(page.locator('.wa-chip-acct')).toHaveText('SolutionsLucy');
        await page.getByPlaceholder('Type a message').fill('Obrigada, confirmado!');
        await page.keyboard.press('Enter');
        await expect(page.locator('.wa-chat-pane').getByText('Obrigada, confirmado!')).toBeVisible();
        const sent = await calls(page, '/send');
        expect(sent).toHaveLength(1);
        expect(sent[0].session).toBe('lucy');
        expect((await calls(page, '/messages')).every((c) => c.session === 'lucy')).toBe(true);
        expect(await noOverflow(page, '.wa-root')).toBe(true);
        await shot(page, theme, tag('chat'));
      });

      test('add account: two clear choices; attach lists the WAHA sessions that are not here yet and attaches one in a click', async ({ page }) => {
        await open(page, theme, {}, size);
        await accountButton(page).click();
        await menu(page).getByRole('menuitem', { name: 'Add account' }).click();
        const dlg = page.getByRole('dialog');
        await expect(dlg.getByRole('heading', { name: 'Add a WhatsApp account' })).toBeVisible();
        await expect(dlg.getByRole('button', { name: /Link a new WhatsApp/ })).toBeVisible();
        await expect(dlg.getByRole('button', { name: /Attach an existing session/ })).toContainText('2 sessions in your WAHA are not in Floq yet');
        await inView(page, '[role=dialog]');
        await shot(page, theme, tag('add'));

        await dlg.getByRole('button', { name: /Attach an existing session/ }).click();
        const items = dlg.getByRole('list', { name: 'Sessions in WAHA' }).getByRole('listitem');
        await expect(items).toHaveCount(2);
        await expect(items.nth(0)).toContainText('Suporte Zoe');
        await expect(items.nth(0)).toContainText('+55 31 97777-6666');
        await expect(items.nth(0)).toContainText('Connected');
        await expect(items.nth(1)).toContainText('testes');
        await expect(items.nth(1)).toContainText('No phone linked yet');
        await expect(items.nth(1)).toContainText('Stopped');
        expect(await noOverflow(page, '[role=dialog]')).toBe(true);
        await inView(page, '[role=dialog]');
        await shot(page, theme, tag('attach'));

        await dlg.getByRole('button', { name: 'Attach Suporte Zoe' }).click();
        await expect(dlg).toBeHidden();
        expect((await calls(page, '/accounts/attach'))[0].body).toEqual({ name: 'suporte' });
        // The new account is on screen at once.
        await expect(accountButton(page)).toHaveAccessibleName(/Suporte Zoe, Connected/);
        await accountButton(page).click();
        await expect(rows(page)).toHaveCount(4);
        await expect(rows(page).nth(3)).toHaveAttribute('aria-checked', 'true');
        await page.keyboard.press('Escape');
        // Only one session is left to attach.
        await accountButton(page).click();
        await menu(page).getByRole('menuitem', { name: 'Add account' }).click();
        await expect(page.getByRole('dialog').getByRole('button', { name: /Attach an existing session/ })).toContainText('1 session in your WAHA is not in Floq yet');
      });

      test('link a new WhatsApp: name it, scan the QR, and the account opens once the phone is linked; cancelling takes it back out', async ({ page }) => {
        await open(page, theme, {}, size);
        await accountButton(page).click();
        await menu(page).getByRole('menuitem', { name: 'Add account' }).click();
        const dlg = page.getByRole('dialog');
        await dlg.getByRole('button', { name: /Link a new WhatsApp/ }).click();
        await dlg.getByLabel('Name in Floq (optional)').fill('Ateliê');
        await shot(page, theme, tag('name'));
        await page.keyboard.press('Enter');
        const qr = dlg.locator('.wa-qr-box svg');
        await expect(qr).toBeVisible();
        expect(await dlg.locator('.wa-qr-box').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
        const box = (await qr.boundingBox())!;
        expect(Math.abs(box.width - box.height)).toBeLessThan(1);
        expect(box.width).toBeGreaterThan(180);
        await expect(dlg.getByText('Scan this code')).toBeVisible();
        await expect(dlg.getByRole('button', { name: 'Link with phone number instead' })).toBeVisible();
        expect((await calls(page, '/accounts/create'))[0].body).toEqual({ label: 'Ateliê' });
        // The QR is the new session's, not the one on screen behind the dialog.
        expect((await calls(page, '/session/qr')).every((c) => c.session === 'floq-4')).toBe(true);
        await inView(page, '[role=dialog]');
        expect(await noOverflow(page, '[role=dialog]')).toBe(true);
        await shot(page, theme, tag('qr'));

        await fake(page, "window.__fake.link('floq-4')");
        await expect(dlg.getByText('WhatsApp is linked')).toBeVisible();
        await expect(dlg.getByText('+55 34 97777-8888')).toBeVisible();
        await shot(page, theme, tag('linked'));
        await dlg.getByRole('button', { name: 'Open the account' }).click();
        await expect(dlg).toBeHidden();
        await expect(accountButton(page)).toHaveAccessibleName(/Ateliê, Connected/);
        expect(await calls(page, '/accounts/remove')).toHaveLength(0);

        // Again, but cancelled before the scan.
        await accountButton(page).click();
        await menu(page).getByRole('menuitem', { name: 'Add account' }).click();
        await page.getByRole('dialog').getByRole('button', { name: /Link a new WhatsApp/ }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Show QR code' }).click();
        await expect(page.getByRole('dialog').locator('.wa-qr-box svg')).toBeVisible();
        await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
        await expect(page.getByRole('dialog')).toBeHidden();
        expect((await calls(page, '/accounts/remove'))[0].body).toEqual({ session: 'floq-5', discard: true });
        await accountButton(page).click();
        await expect(rows(page)).toHaveCount(4);
      });

      test('remove from Floq asks first, says the phone stays linked, and the inbox moves to another account', async ({ page }) => {
        await open(page, theme, {}, size);
        await accountButton(page).click();
        await rows(page).nth(1).click();
        await expect(page.getByText('Clínica Bem Viver')).toBeVisible();
        await accountButton(page).click();
        await menu(page).getByRole('menuitem', { name: 'Remove from Floq' }).click();
        const dlg = page.getByRole('dialog');
        await expect(dlg.getByRole('heading', { name: 'Remove SolutionsLucy from Floq?' })).toBeVisible();
        await expect(dlg).toContainText('Your phone stays linked');
        await expect(dlg.getByRole('checkbox')).not.toBeChecked();
        await inView(page, '[role=dialog]');
        await shot(page, theme, tag('remove'));
        await dlg.getByRole('button', { name: 'Cancel' }).click();
        await expect(dlg).toBeHidden();
        expect(await calls(page, '/accounts/remove')).toHaveLength(0);

        await accountButton(page).click();
        await menu(page).getByRole('menuitem', { name: 'Remove from Floq' }).click();
        await page.getByRole('dialog').getByRole('checkbox').check();
        await page.getByRole('dialog').getByRole('button', { name: 'Remove from Floq' }).click();
        await expect(page.getByRole('dialog')).toBeHidden();
        expect((await calls(page, '/accounts/remove'))[0].body).toEqual({ session: 'lucy', deleteData: true });
        await expect(page.getByText('Marina Costa').first()).toBeVisible();
        await accountButton(page).click();
        await expect(rows(page)).toHaveCount(2);
        await expect(rows(page).nth(0)).toHaveAttribute('aria-checked', 'true');
      });
    });
  }

  test(`${theme}: keyboard: the menu opens, moves and switches without a mouse; rename and "default for the AI" are per account`, async ({ page }) => {
    await open(page, theme);
    await expect(page.getByText('Marina Costa').first()).toBeVisible();
    await accountButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    // Opened by keyboard, the menu puts focus on its first row (a frame later): wait for it, then move.
    await expect(rows(page).nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(rows(page).nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(accountButton(page)).toHaveAccessibleName(/SolutionsLucy, Connected/);
    await expect(page.getByText('Clínica Bem Viver')).toBeVisible();
    // Rename.
    await accountButton(page).click();
    await menu(page).getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByLabel('Name in Floq').fill('Pessoal');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeHidden();
    expect((await calls(page, '/accounts/update'))[0].body).toEqual({ session: 'lucy', label: 'Pessoal' });
    await expect(accountButton(page)).toHaveAccessibleName(/Pessoal, Connected/);
    // Default for the AI: only offered on an account that is not the default yet.
    await accountButton(page).click();
    await menu(page).getByRole('menuitem', { name: 'Make default for the AI' }).click();
    await expect.poll(async () => (await calls(page, '/accounts/update')).at(-1)!.body).toEqual({ session: 'lucy', primary: true });
    await accountButton(page).click();
    await expect(rows(page).nth(0)).toContainText('Pessoal');
    await expect(menu(page).getByRole('menuitem', { name: 'Make default for the AI' })).toHaveCount(0);
  });

  test(`${theme}: a message for another account does not touch the open inbox; it raises that account's count`, async ({ page }) => {
    await open(page, theme);
    await expect(page.getByText('Marina Costa').first()).toBeVisible();
    await page.getByRole('button', { name: /Marina Costa/ }).first().click();
    const before = (await calls(page, '/messages')).length;
    await fake(page, "window.__fake.of('lucy').incoming('5534995556677@c.us', 'Chegou?', '5534995556677@c.us', 'João Pedro')");
    await expect(accountButton(page)).toHaveAccessibleName(/5 unread in other accounts/);
    expect((await calls(page, '/messages')).length).toBe(before);
    await expect(page.locator('.wa-list-pane').getByText('Chegou?')).toHaveCount(0);
    // One for this account still arrives as before.
    await fake(page, "window.__fake.incoming('5511987654321@c.us', 'Pode ser às 15h?', '5511987654321@c.us', 'Marina Costa')");
    await expect(page.locator('.wa-chat-pane').getByText('Pode ser às 15h?')).toBeVisible();
  });

  test(`${theme}: one account looks like before, plus "Add account"; with none left the inbox offers to add one`, async ({ page }) => {
    await open(page, theme, { accounts: '1' });
    await expect(page.getByText('Marina Costa').first()).toBeVisible();
    await expect(page.locator('.wa-chip-acct')).toHaveCount(0);
    await expect(page.locator('.wa-acct-n')).toHaveCount(0);
    await accountButton(page).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(menu(page).getByRole('menuitem', { name: 'Add account' })).toBeVisible();
    await expect(menu(page).getByRole('menuitem', { name: 'Restart' })).toBeVisible();
    await shot(page, theme, 'single');
    await menu(page).getByRole('menuitem', { name: 'Remove from Floq' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove from Floq' }).click();
    await expect(page.getByText('No WhatsApp account yet')).toBeVisible();
    await shot(page, theme, 'empty');
    await page.getByRole('button', { name: 'Add account' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: /Link a new WhatsApp/ })).toBeVisible();
  });

  for (const [name, query] of [['solid', { material: 'solid', frame: '1' }], ['native', { native: 'acrylic', frame: '1' }]] as const) {
    test(`${theme} ${name} material: the switcher and the add dialog follow the host surface`, async ({ page }) => {
      await open(page, theme, query);
      await expect(page.getByText('Marina Costa').first()).toBeVisible();
      await accountButton(page).click();
      await expect(rows(page)).toHaveCount(3);
      await shot(page, theme, `switcher-${name}`);
      await menu(page).getByRole('menuitem', { name: 'Add account' }).click();
      await expect(page.getByRole('dialog').getByRole('button', { name: /Link a new WhatsApp/ })).toBeVisible();
      await shot(page, theme, `add-${name}`);
    });
  }
}

test('a failed "Link a new WhatsApp" says why and keeps the dialog open', async ({ page }) => {
  await open(page, 'light');
  await accountButton(page).click();
  await menu(page).getByRole('menuitem', { name: 'Add account' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: /Link a new WhatsApp/ }).click();
  await dlg.getByLabel('Name in Floq (optional)').fill('x #fail');
  await dlg.getByRole('button', { name: 'Show QR code' }).click();
  await expect(dlg.getByRole('alert')).toContainText('Only one session is available in WAHA Core');
  await expect(dlg.getByRole('button', { name: 'Show QR code' })).toBeEnabled();
});
