// The WAHA plugin's chat menu, contact/group info panel and new chat / new group dialogs, driven from the plugin's BUILT package in its ?demo=people stand-in inbox:
// third column and overlay layouts, every action's request, engine gating, light and dark, wide (1100x760) and narrow (380x760).
//   WAHA_PLUGIN_DIR=checkout  (after npm run build there)   WAHA_SHOTS=dir  (default: the Artifacts folder)
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const pluginDir = process.env.WAHA_PLUGIN_DIR ?? path.resolve(process.env.HOME ?? '.', 'work/floq-plugin-waha');
const dist = path.join(pluginDir, 'dist');
const pkgFile = existsSync(dist) ? readdirSync(dist).find((f) => /^waha-.*\.floqpkg\.json$/.test(f)) : undefined;
const shots = process.env.WAHA_SHOTS ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
test.skip(!pkgFile, 'no built WAHA plugin package: set WAHA_PLUGIN_DIR and run npm run build there');
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const WIDE = { width: 1100, height: 760 }, NARROW = { width: 380, height: 760 };
type Call = { path: string; method: string; body?: any };

async function open(page: Page, theme: string, o: { size?: { width: number; height: number }; chat?: string; query?: string } = {}) {
  await page.setViewportSize(o.size ?? WIDE);
  await page.route('**/__waha/pkg.json', (route) => route.fulfill({ contentType: 'application/json', body: readFileSync(path.join(dist, pkgFile!), 'utf8') }));
  await page.goto('/e2e/harness/waha-people.html?demo=people' + (theme === 'dark' ? '&theme=dark' : '') + (o.query ? '&' + o.query : ''));
  await expect(page.locator('.wa-row').first()).toBeVisible();
  if (o.chat) await page.locator('.wa-row', { hasText: o.chat }).click();
}
async function shot(page: Page, theme: string, name: string, keepMouse = false) {
  mkdirSync(shots, { recursive: true });
  if (!keepMouse) await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `waha-full-people-${theme}-${name}.png`) });
}
const calls = (page: Page, p?: string) => page.evaluate((x) => (window as unknown as { __calls: Call[] }).__calls.filter((c) => !x || c.path === x), p);
const noOverflow = async (page: Page, sel: string) => expect(await page.locator(sel).first().evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
const menu = (page: Page, name: RegExp | string = /^Menu of/) => page.getByRole('button', { name });
const item = (page: Page, name: string | RegExp) => page.getByRole('menuitem', { name });

for (const theme of ['light', 'dark']) {
  test.describe(theme, () => {
    test('wide: contact info is a third column with the contact, about and actions', async ({ page }) => {
      await open(page, theme, { chat: 'Marina Costa' });
      await page.getByRole('button', { name: 'Contact info' }).click();
      const info = page.getByRole('complementary', { name: 'Contact info' });
      await expect(info).toBeVisible();
      await expect(info.getByRole('heading', { name: 'Marina Costa' })).toBeVisible();
      await expect(info.getByText('+55 11 98765-4321')).toBeVisible();
      await expect(info.getByText('Disponível para pedidos')).toBeVisible();
      for (const t of ['Edit contact name', 'Refresh photo', 'Marina Costa is the same person as another chat', 'Block Marina Costa']) await expect(info.getByRole('button', { name: t })).toBeVisible();
      await expect(info.getByText('This is the same person as…')).toBeVisible();
      // a real column: to the right of the conversation, inside the viewport, nothing overflows
      const box = (await info.boundingBox())!, conv = (await page.getByLabel('Conversation').boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(conv.x + conv.width - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(1101);
      expect(conv.width).toBeGreaterThan(380);
      await noOverflow(page, '.wa-info-scroll');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(info.locator('.wa-pic-xl img')).toBeVisible();
      await shot(page, theme, 'info-contact');
      await info.getByRole('button', { name: 'Close info' }).click();
      await expect(info).toBeHidden();
    });

    test('wide: group info lists participants with roles, description, settings, invite and exit', async ({ page }) => {
      await open(page, theme, { chat: 'Equipe Zoe' });
      await page.getByRole('button', { name: 'Group info' }).click();
      const info = page.getByRole('complementary', { name: 'Group info' });
      await expect(info.getByRole('heading', { name: 'Equipe Zoe · Produção' })).toBeVisible();
      await expect(info.getByText('Group · 9 participants')).toBeVisible();
      await expect(info.getByText('Pedidos, produção e entregas')).toBeVisible();
      await expect(info.getByText('Group created on')).toBeVisible();
      await expect(info.locator('.wa-member')).toHaveCount(9);
      await expect(info.locator('.wa-role')).toHaveCount(3);
      await expect(info.locator('.wa-member').first()).toContainText('You');
      await expect(info.locator('.wa-member', { hasText: 'Bia Nogueira' }).locator('.wa-role')).toHaveAttribute('title', 'Group admin');
      await expect(info.locator('.wa-member', { hasText: 'Rafael Souza' }).locator('.wa-role')).toHaveAttribute('title', 'Group owner');
      await expect(info.getByRole('switch')).toHaveCount(2);
      for (const t of ['Add participant', 'Invite to group via link', 'Exit group']) await expect(info.getByRole('button', { name: t })).toBeVisible();
      await noOverflow(page, '.wa-info-scroll');
      await shot(page, theme, 'info-group');
      await info.locator('.wa-info-scroll').evaluate((e) => (e.scrollTop = e.scrollHeight));
      await shot(page, theme, 'info-group-bottom');
      // search participants
      await info.getByRole('button', { name: 'Search participants' }).click();
      await info.getByRole('searchbox').fill('souza');
      await expect(info.locator('.wa-member')).toHaveCount(2);
      await info.getByRole('searchbox').fill('zzz');
      await expect(info.getByText('No participants match')).toBeVisible();
    });

    test('chat menu: every entry, the mute choices, and what each one sends', async ({ page }) => {
      await open(page, theme, { chat: 'Marina Costa' });
      await menu(page).click();
      for (const t of ['Contact info', 'Archive chat', 'Pin chat', 'Mute notifications', 'Mark as read', 'Block', 'Clear chat', 'Delete chat']) await expect(item(page, t)).toBeVisible();
      await expect(item(page, 'Exit group')).toHaveCount(0);
      await shot(page, theme, 'menu', true);
      await item(page, 'Mute notifications').hover();
      for (const t of ['8 hours', '1 week', 'Always']) await expect(item(page, t)).toBeVisible();
      await shot(page, theme, 'menu-mute', true);
      await item(page, '8 hours').click();
      const mute = (await calls(page, '/chat/mute')).at(-1)!;
      expect(mute.body.chatId).toBe('5511987654321@c.us');
      expect(new Date(mute.body.until).getTime() - Date.now()).toBeGreaterThan(7.9 * 3600_000);
      expect(new Date(mute.body.until).getTime() - Date.now()).toBeLessThan(8.1 * 3600_000);
      await expect(page.getByText('Notifications muted')).toBeVisible();
      // pin, unread, read
      await menu(page).click(); await item(page, 'Pin chat').click();
      expect((await calls(page, '/chat/pin')).at(-1)!.body).toEqual({ chatId: '5511987654321@c.us', pinned: true });
      await menu(page).click(); await expect(item(page, 'Unmute notifications')).toBeVisible(); await item(page, 'Mark as read').click();
      expect((await calls(page, '/read')).at(-1)!.body).toEqual({ chatId: '5511987654321@c.us' });
      await menu(page).click(); await item(page, 'Mark as unread').click();
      expect((await calls(page, '/chat/unread')).at(-1)!.body).toEqual({ chatId: '5511987654321@c.us' });
      // archive: the chat leaves the list
      await menu(page).click(); await item(page, 'Archive chat').click();
      expect((await calls(page, '/chat/archive')).at(-1)!.body).toEqual({ chatId: '5511987654321@c.us', archived: true });
      await expect(page.locator('.wa-row', { hasText: 'Marina Costa' })).toHaveCount(0);
    });

    test('chat menu: clear and delete ask first; delete closes the chat', async ({ page }) => {
      await open(page, theme, { chat: 'Papelaria Aurora' });
      await menu(page).click(); await item(page, 'Clear chat').click();
      const dlg = page.getByRole('alertdialog');
      await expect(dlg).toContainText('Clear this chat?');
      await shot(page, theme, 'confirm-clear');
      await dlg.getByRole('button', { name: 'Cancel' }).click();
      expect(await calls(page, '/chat/clear')).toHaveLength(0);
      await menu(page).click(); await item(page, 'Clear chat').click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Clear chat' }).click();
      await expect.poll(async () => (await calls(page, '/chat/clear')).length).toBe(1);
      await menu(page).click(); await item(page, 'Delete chat').click();
      await expect(page.getByRole('alertdialog')).toContainText('Delete this chat?');
      await shot(page, theme, 'confirm-delete');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete chat' }).click();
      expect((await calls(page, '/chat/delete')).at(-1)!.body).toEqual({ chatId: '5531988887777@c.us' });
      await expect(page.locator('.wa-row', { hasText: 'Papelaria Aurora' })).toHaveCount(0);
      await expect(page.getByLabel('Conversation').getByText('Pick a chat')).toBeVisible();
    });

    test('group chat menu has Exit group; block and info are for 1:1 chats', async ({ page }) => {
      await open(page, theme, { chat: 'Equipe Zoe' });
      await menu(page).click();
      await expect(item(page, 'Group info')).toBeVisible();
      await expect(item(page, 'Exit group')).toBeVisible();
      await expect(item(page, 'Block')).toHaveCount(0);
      await expect(item(page, 'Unpin chat')).toBeVisible();
      await item(page, 'Exit group').click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Exit group' }).click();
      expect((await calls(page, '/group/leave')).at(-1)!.body).toEqual({ chatId: '120363041234567890@g.us' });
    });

    test('contact actions: block, save, refresh photo', async ({ page }) => {
      await open(page, theme, { chat: 'Marina Costa', query: 'info=1' });
      const info = page.getByRole('complementary', { name: 'Contact info' });
      await info.getByRole('button', { name: 'Block Marina Costa' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Block', exact: true }).click();
      expect((await calls(page, '/contact/block')).at(-1)!.body).toEqual({ chatId: '5511987654321@c.us', blocked: true });
      await expect(info.getByRole('button', { name: 'Unblock Marina Costa' })).toBeVisible();
      await info.getByRole('button', { name: 'Edit contact name' }).click();
      const dlg = page.getByRole('dialog', { name: 'Save to contacts' });
      await expect(dlg.getByLabel('First name')).toHaveValue('Marina');
      await expect(dlg.getByLabel('Last name')).toHaveValue('Costa');
      await shot(page, theme, 'save-contact');
      await dlg.getByLabel('Last name').fill('Costa Lima');
      await dlg.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await calls(page, '/contact/save')).at(-1)!.body).toEqual({ chatId: '5511987654321@c.us', firstName: 'Marina', lastName: 'Costa Lima' });
      await info.getByRole('button', { name: 'Refresh photo' }).click();
      await expect.poll(async () => (await calls(page, '/contact/refresh-picture')).length).toBe(1);
    });

    test('same person: pick the other chat and merge', async ({ page }) => {
      await open(page, theme, { chat: 'Marina Costa', query: 'info=1' });
      const info = page.getByRole('complementary', { name: 'Contact info' });
      await info.getByRole('button', { name: /same person/ }).click();
      const dlg = page.getByRole('dialog', { name: 'Same person, two chats' });
      await expect(dlg.getByRole('button', { name: /Marina Costa/ })).toHaveCount(0);
      await shot(page, theme, 'merge-pick');
      await dlg.getByRole('searchbox').fill('papelaria');
      await dlg.getByRole('button', { name: /Papelaria Aurora/ }).click();
      await expect(dlg).toContainText('Merge Marina Costa with Papelaria Aurora?');
      await shot(page, theme, 'merge-confirm');
      await dlg.getByRole('button', { name: 'Merge chats' }).click();
      expect((await calls(page, '/link')).at(-1)!.body).toEqual({ chatId: '5511987654321@c.us', withChatId: '5531988887777@c.us' });
      await expect(dlg).toBeHidden();
    });

    test('an unknown contact (lid): merged ids are mentioned', async ({ page }) => {
      await open(page, theme, { chat: 'Olá, vocês fazem', query: 'info=1' });
      const info = page.getByRole('complementary', { name: 'Contact info' });
      await expect(info.getByRole('heading', { name: 'Priscila' })).toBeVisible();
      await expect(info.getByText('combines 2 WhatsApp ids')).toBeVisible();
      await shot(page, theme, 'info-unknown');
    });

    test('new chat: search contacts, open one; a typed number is checked first', async ({ page }) => {
      await open(page, theme);
      await page.getByRole('button', { name: 'New chat' }).click();
      const dlg = page.getByRole('dialog', { name: 'New chat' });
      await expect(dlg.locator('.wa-pickrow').first()).toBeVisible();
      await expect(dlg.getByRole('button', { name: /New group/ })).toBeVisible();
      await shot(page, theme, 'new-chat');
      await dlg.getByRole('searchbox').fill('souza');
      await expect(dlg.locator('.wa-pickrow')).toHaveCount(3); // new group + Ana + Rafael
      await dlg.getByRole('searchbox').fill('zzzz');
      await expect(dlg.getByText('No contacts match')).toBeVisible();
      await dlg.getByRole('searchbox').fill('');
      // number tab
      await dlg.getByRole('button', { name: 'Phone number' }).click();
      const field = dlg.getByRole('textbox', { name: 'Phone number' });
      await field.fill('11999990000');
      await expect(field).toHaveValue('(11) 99999-0000');
      await dlg.getByRole('button', { name: 'Start chat' }).click();
      await expect(dlg.getByRole('alert')).toContainText('is not on WhatsApp');
      expect((await calls(page, '/contacts/check')).at(-1)!.body).toEqual({ phone: '+5511999990000' });
      await shot(page, theme, 'new-chat-number');
      await field.fill('11977776666');
      await dlg.getByRole('button', { name: 'Start chat' }).click();
      await expect(dlg).toBeHidden();
      await expect(page.getByLabel('Conversation')).toContainText('+55 11 97777-6666');
      // reopening starts clean
      await page.getByRole('button', { name: 'New chat' }).click();
      await expect(page.getByRole('dialog', { name: 'New chat' }).getByRole('button', { name: 'Contacts' })).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Escape');
      // a contact opens its chat
      await page.getByRole('button', { name: 'New chat' }).click();
      await page.getByRole('dialog').getByRole('button', { name: /Rafael Souza/ }).click();
      await expect(page.getByLabel('Conversation')).toContainText('Rafael Souza');
    });

    test('new group: pick people, name it, create it', async ({ page }) => {
      await open(page, theme);
      await page.getByRole('button', { name: 'New chat' }).click();
      await page.getByRole('dialog').getByRole('button', { name: /New group/ }).click();
      const dlg = page.getByRole('dialog', { name: 'Add group participants' });
      await expect(dlg.getByRole('button', { name: 'Next' })).toBeDisabled();
      for (const n of ['Ana Souza', 'Bruno Lima', 'Carla Mendes']) await dlg.getByRole('button', { name: new RegExp(n) }).click();
      await expect(dlg.locator('.wa-tag')).toHaveCount(3);
      await shot(page, theme, 'new-group-pick');
      await dlg.getByRole('button', { name: 'Remove Bruno Lima' }).click();
      await expect(dlg.locator('.wa-tag')).toHaveCount(2);
      await dlg.getByRole('button', { name: 'Next (2)' }).click();
      const name = page.getByRole('dialog', { name: 'New group' });
      await expect(name.getByRole('button', { name: 'Create group' })).toBeDisabled();
      await name.getByLabel('Group name').fill('Fornecedores');
      await shot(page, theme, 'new-group-name');
      await name.getByRole('button', { name: 'Back' }).click();
      await expect(page.getByRole('dialog', { name: 'Add group participants' }).locator('.wa-tag')).toHaveCount(2);
      await page.getByRole('dialog').getByRole('button', { name: 'Next (2)' }).click();
      await page.getByLabel('Group name').fill('Fornecedores');
      await page.getByRole('button', { name: 'Create group' }).click();
      const c = (await calls(page, '/group/create')).at(-1)!;
      expect(c.body).toEqual({ name: 'Fornecedores', participants: ['5534999990000@c.us', '5531955554444@c.us'] });
      await expect(page.getByLabel('Conversation')).toContainText('Fornecedores');
      await expect(page.getByText('Group created')).toBeVisible();
    });

    test('group admin: rename, description, settings, add, promote, remove', async ({ page }) => {
      await open(page, theme, { chat: 'Equipe Zoe', query: 'info=1' });
      const info = page.getByRole('complementary', { name: 'Group info' });
      await info.getByRole('button', { name: 'Edit group name' }).click();
      await info.getByLabel('Group name').fill('Equipe Zoe 2');
      await shot(page, theme, 'group-edit');
      await info.getByLabel('Group name').press('Enter');
      expect((await calls(page, '/group/subject')).at(-1)!.body).toEqual({ chatId: '120363041234567890@g.us', subject: 'Equipe Zoe 2' });
      await expect(info.getByRole('heading', { name: 'Equipe Zoe 2' })).toBeVisible();
      await info.getByRole('button', { name: 'Edit group description' }).click();
      await info.getByLabel('Group description').fill('Nova descrição');
      await info.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await calls(page, '/group/description')).at(-1)!.body.description).toBe('Nova descrição');
      await expect(info.getByText('Nova descrição')).toBeVisible();
      await info.getByRole('switch', { name: 'Only admins can send messages' }).click();
      expect((await calls(page, '/group/settings')).at(-1)!.body).toEqual({ chatId: '120363041234567890@g.us', announce: true });
      await info.getByRole('switch', { name: 'Only admins can edit group info' }).click();
      expect((await calls(page, '/group/settings')).at(-1)!.body).toEqual({ chatId: '120363041234567890@g.us', restrict: true });
      // promote + remove through the participant menu
      const ana = info.locator('.wa-member', { hasText: 'Ana Souza' });
      await ana.hover();
      await ana.getByRole('button', { name: /Options for/ }).click();
      for (const t of [/^Message/, 'Make group admin', 'Remove from group']) await expect(item(page, t)).toBeVisible();
      await shot(page, theme, 'member-menu', true);
      await item(page, 'Make group admin').click();
      expect((await calls(page, '/group/participants')).at(-1)!.body).toEqual({ chatId: '120363041234567890@g.us', action: 'promote', participants: ['5534999990000@c.us'] });
      await expect(ana.locator('.wa-role')).toHaveCount(1);
      await ana.getByRole('button', { name: /Options for/ }).click();
      await expect(item(page, 'Dismiss as admin')).toBeVisible();
      await page.keyboard.press('Escape');
      const carla = info.locator('.wa-member', { hasText: 'Carla Mendes' });
      await carla.getByRole('button', { name: /Options for/ }).click();
      await item(page, 'Remove from group').click();
      await expect(page.getByRole('alertdialog')).toContainText('Remove Carla Mendes?');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
      expect((await calls(page, '/group/participants')).at(-1)!.body.action).toBe('remove');
      await expect(info.locator('.wa-member', { hasText: 'Carla Mendes' })).toHaveCount(0);
      // the owner cannot be managed
      await info.locator('.wa-member', { hasText: 'Rafael Souza' }).getByRole('button', { name: /Options for/ }).click();
      await expect(item(page, 'Remove from group')).toHaveCount(0);
    });

    test('group: add participants and the invite link', async ({ page }) => {
      await open(page, theme, { chat: 'Equipe Zoe', query: 'info=1' });
      const info = page.getByRole('complementary', { name: 'Group info' });
      await info.getByRole('button', { name: 'Add participant' }).click();
      const add = page.getByRole('dialog', { name: 'Add participants' });
      await expect(add.getByRole('button', { name: /Ana Souza/ })).toHaveCount(0); // already in the group
      await add.getByRole('button', { name: /Lucas/ }).click();
      await shot(page, theme, 'add-participants');
      await add.getByRole('button', { name: 'Add 1' }).click();
      expect((await calls(page, '/group/participants')).at(-1)!.body).toEqual({ chatId: '120363041234567890@g.us', action: 'add', participants: ['5541977776666@c.us'] });
      await expect(info.getByText('Group · 10 participants')).toBeVisible();
      await info.getByRole('button', { name: 'Invite to group via link' }).click();
      const inv = page.getByRole('dialog', { name: 'Invite to group via link' });
      await expect(inv.getByLabel('Invite link')).toHaveValue('https://chat.whatsapp.com/Kx7Qp2LmN9aVb1');
      await shot(page, theme, 'invite');
      await inv.getByRole('button', { name: 'Copy link' }).click();
      await expect(page.getByText('Link copied')).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://chat.whatsapp.com/Kx7Qp2LmN9aVb1');
      await inv.getByRole('button', { name: 'Reset link' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Reset link' }).click();
      await expect(inv.getByLabel('Invite link')).toHaveValue('https://chat.whatsapp.com/Kx7Qp2LmN9aVb2');
    });

    test('not an admin: no editing, no settings, no add or remove', async ({ page }) => {
      await open(page, theme, { chat: 'Equipe Zoe', query: 'info=1&admin=0' });
      const info = page.getByRole('complementary', { name: 'Group info' });
      await expect(info.getByText('Group · 9 participants')).toBeVisible();
      await expect(info.getByRole('button', { name: /Edit group/ })).toHaveCount(0);
      await expect(info.getByRole('switch')).toHaveCount(0);
      await expect(info.getByRole('button', { name: 'Add participant' })).toHaveCount(0);
      await info.locator('.wa-member', { hasText: 'Ana Souza' }).getByRole('button', { name: /Options for/ }).click();
      await expect(item(page, /^Message/)).toBeVisible();
      await expect(item(page, 'Make group admin')).toHaveCount(0);
      await expect(item(page, 'Remove from group')).toHaveCount(0);
      await shot(page, theme, 'info-group-member');
    });

    test('GOWS: block is hidden; archive still works and says it is local', async ({ page }) => {
      await open(page, theme, { chat: 'Marina Costa', query: 'engine=GOWS&info=1' });
      await expect(page.getByRole('complementary').getByRole('button', { name: /Block/ })).toHaveCount(0);
      await expect(page.getByRole('complementary').getByText('Disponível para pedidos')).toHaveCount(0);
      await menu(page).click();
      await expect(item(page, 'Block')).toHaveCount(0);
      await item(page, 'Archive chat').click();
      await expect(page.getByText('Only in Floq')).toBeVisible();
    });

    test('narrow: the info panel overlays the chat and fits 380px; dialogs fit too', async ({ page }) => {
      await open(page, theme, { size: NARROW, chat: 'Equipe Zoe' });
      await page.getByRole('button', { name: 'Group info' }).click();
      const info = page.getByRole('complementary', { name: 'Group info' });
      await expect(info).toBeVisible();
      await page.waitForTimeout(350); // the slide-in
      const b = (await info.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(381); expect(b.width).toBeGreaterThanOrEqual(340);
      await noOverflow(page, '.wa-info-scroll');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await shot(page, theme, 'narrow-info-group');
      await info.locator('.wa-info-scroll').evaluate((e) => (e.scrollTop = 400));
      await shot(page, theme, 'narrow-info-group-members');
      await info.getByRole('button', { name: 'Invite to group via link' }).click();
      const dlg = page.getByRole('dialog');
      const d = (await dlg.boundingBox())!;
      expect(d.x).toBeGreaterThanOrEqual(0); expect(d.x + d.width).toBeLessThanOrEqual(381);
      await shot(page, theme, 'narrow-invite');
      await page.keyboard.press('Escape');
      await info.getByRole('button', { name: 'Close info' }).click();
      await expect(info).toBeHidden();
      await page.getByRole('button', { name: 'Back to chats' }).click();
      await page.getByRole('button', { name: 'New chat' }).click();
      const nc = page.getByRole('dialog', { name: 'New chat' });
      await expect(nc.locator('.wa-pickrow').first()).toBeVisible();
      const n = (await nc.boundingBox())!;
      expect(n.x).toBeGreaterThanOrEqual(0); expect(n.x + n.width).toBeLessThanOrEqual(381); expect(n.y + n.height).toBeLessThanOrEqual(761);
      await shot(page, theme, 'narrow-new-chat');
      await nc.getByRole('button', { name: 'Phone number' }).click();
      expect(await nc.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      await shot(page, theme, 'narrow-new-chat-number');
    });

    test('narrow: contact info and chat menu', async ({ page }) => {
      await open(page, theme, { size: NARROW, chat: 'Marina Costa' });
      await page.getByRole('button', { name: 'Contact info' }).click();
      await noOverflow(page, '.wa-info-scroll');
      await shot(page, theme, 'narrow-info-contact');
      await page.getByRole('button', { name: 'Close info' }).click();
      await menu(page).click();
      const m = (await page.getByRole('menu').boundingBox())!;
      expect(m.x).toBeGreaterThanOrEqual(0); expect(m.x + m.width).toBeLessThanOrEqual(381);
      await shot(page, theme, 'narrow-menu', true);
    });

    test('keyboard: Escape closes the panel, menus open with Enter and arrows move', async ({ page }) => {
      await open(page, theme, { chat: 'Marina Costa', query: 'info=1' });
      const info = page.getByRole('complementary', { name: 'Contact info' });
      await expect(info).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(info).toBeHidden();
      await menu(page).focus();
      await page.keyboard.press('Enter');
      await expect(item(page, 'Contact info')).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(item(page, 'Archive chat')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu(page)).toBeFocused();
    });
  });
}
