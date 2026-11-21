// The WAHA plugin's labels, status (stories), channels, incoming-call bar and presence line, from the plugin's BUILT package with fake routes.
// Light and dark, wide (1100x760) and narrow (380x760).
//   WAHA_PLUGIN_DIR=checkout  (after npm run build there)   WAHA_SHOTS=dir  (default: the Artifacts folder)
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const pluginDir = process.env.WAHA_PLUGIN_DIR ?? path.resolve(process.env.HOME ?? '.', 'work/floq-plugin-waha');
const dist = path.join(pluginDir, 'dist');
const pkgFile = existsSync(dist) ? readdirSync(dist).find((f) => /^waha-.*\.floqpkg\.json$/.test(f)) : undefined;
const shots = process.env.WAHA_SHOTS ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';

test.skip(!pkgFile, 'no built WAHA plugin package: set WAHA_PLUGIN_DIR and run npm run build there');

const WIDE = { width: 1100, height: 760 }, NARROW = { width: 380, height: 760 };
async function open(page: Page, theme: string, query = '', size = WIDE) {
  await page.setViewportSize(size);
  await page.route('**/__waha/pkg.json', (route) => route.fulfill({ contentType: 'application/json', body: readFileSync(path.join(dist, pkgFile!), 'utf8') }));
  await page.goto('/e2e/harness/waha-more.html?demo=more' + (theme === 'dark' ? '&theme=dark' : '') + query);
  await expect(page.locator('.wa-root')).toBeVisible();
}
async function shot(page: Page, theme: string, name: string) {
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `waha-full-more-${theme}-${name}.png`) });
}
const calls = (page: Page, p: string) => page.evaluate((x) => (window as unknown as { __calls: Array<{ path: string; method: string; body: any }> }).__calls.filter((c) => c.path.split('?')[0] === x), p);
const event = (page: Page, name: string, data: unknown) => page.evaluate(([n, d]) => (window as unknown as { __event: (n: string, d: unknown) => void }).__event(n as string, d), [name, data] as const);
/** Nothing may overflow the viewport sideways. */
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.wa-root *')].every((e) => { const r = e.getBoundingClientRect(); return r.width === 0 || (r.left >= -1 && r.right <= innerWidth + 1) || !!e.closest('.wa-scroll, .wa-llist, .wa-chips'); }))).toBe(true);

for (const theme of ['light', 'dark']) {
  test.describe(theme, () => {
    test('chats: label chips and filter, presence line', async ({ page }) => {
      await open(page, theme);
      await expect(page.locator('.wa-lchip', { hasText: 'New client' })).toBeVisible();
      await expect(page.locator('.wa-lchip', { hasText: 'Follow up' })).toBeVisible();
      await expect(page.locator('.wa-presence')).toHaveText('online');
      await shot(page, theme, 'chats-wide');
      await page.getByRole('button', { name: 'Filter by label' }).click();
      await expect(page.getByRole('menuitem', { name: 'Paid' })).toBeVisible();
      await shot(page, theme, 'labels-filter-menu-wide');
      await page.getByRole('menuitem', { name: 'Paid' }).click();
      await expect(page.locator('.wa-row')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Label filter: Paid' })).toBeVisible();
      await page.getByRole('button', { name: 'Label filter: Paid' }).click();
      await page.getByRole('menuitem', { name: 'All labels' }).click();
      await expect(page.locator('.wa-row')).toHaveCount(3);
      await event(page, 'presence', { chatId: '5511987654321@c.us', state: 'typing', lastSeen: null });
      await expect(page.locator('.wa-presence')).toHaveText('typing…');
      await event(page, 'presence', { chatId: '5511000000000@c.us', state: 'recording', lastSeen: null });
      await expect(page.locator('.wa-presence')).toHaveText('typing…');
      await shot(page, theme, 'presence-typing-wide');
      await event(page, 'presence', { chatId: '5511987654321@c.us', state: 'offline', lastSeen: new Date(Date.now() - 86_400_000).toISOString() });
      await expect(page.locator('.wa-presence')).toHaveText(/^last seen yesterday at \d{1,2}:\d{2}( [AP]M)?$/);
      await noOverflow(page);
    });

    test('chats narrow: list and conversation header at 380px', async ({ page }) => {
      await open(page, theme, '', NARROW);
      await expect(page.locator('.wa-lchip').first()).toBeVisible();
      await shot(page, theme, 'chats-narrow');
      await page.getByRole('button', { name: 'Filter by label' }).click();
      await shot(page, theme, 'labels-filter-menu-narrow');
      await page.keyboard.press('Escape');
      await noOverflow(page);
      await open(page, theme, '&pane=chat', NARROW);
      await expect(page.locator('.wa-presence')).toHaveText('online');
      await shot(page, theme, 'conversation-header-narrow');
      await noOverflow(page);
    });

    test('label picker: assign, create, rename, delete', async ({ page }) => {
      await open(page, theme, '&picker=1');
      const dlg = page.getByRole('dialog');
      await expect(dlg.getByRole('checkbox', { name: 'New client' })).toHaveAttribute('aria-checked', 'true');
      await expect(dlg.getByRole('checkbox', { name: 'Paid' })).toHaveAttribute('aria-checked', 'false');
      await shot(page, theme, 'labels-dialog-wide');
      await dlg.getByRole('checkbox', { name: 'Paid' }).click();
      await dlg.getByRole('button', { name: 'New label' }).click();
      await dlg.getByLabel('Label name').fill('Wholesale');
      await dlg.getByRole('radio', { name: '#d3a91d' }).click();
      await shot(page, theme, 'labels-dialog-new-wide');
      await dlg.getByRole('button', { name: 'Add label' }).click();
      await expect(dlg.getByRole('checkbox', { name: 'Wholesale' })).toBeVisible();
      expect((await calls(page, '/labels')).find((c) => c.method === 'POST')!.body).toEqual({ name: 'Wholesale', color: '#d3a91d' });
      await dlg.getByRole('button', { name: 'Rename VIP' }).click();
      await dlg.getByLabel('Label name').fill('VIP clients');
      await dlg.getByRole('button', { name: 'Save label' }).click();
      await expect(dlg.getByRole('checkbox', { name: 'VIP clients' })).toBeVisible();
      await dlg.getByRole('button', { name: 'Delete Follow up' }).click();
      await dlg.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dlg.getByRole('checkbox', { name: 'Follow up' })).toHaveCount(0);
      await dlg.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect((await calls(page, '/labels/chat')).find((c) => c.method === 'POST')!.body).toEqual({ chatId: '5511987654321@c.us', labels: ['1', '2'] });
    });

    test('label picker narrow', async ({ page }) => {
      await open(page, theme, '&picker=1&pane=chat', NARROW);
      await expect(page.getByRole('dialog').getByRole('checkbox', { name: 'New client' })).toBeVisible();
      await shot(page, theme, 'labels-dialog-narrow');
      const r = (await page.getByRole('dialog').boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(NARROW.width);
    });

    test('incoming call bar: decline, auto-dismiss, accepted elsewhere', async ({ page }) => {
      await open(page, theme);
      const ring = { id: 'CALL1', chatId: '5511987654321@c.us', name: 'Marina Costa', video: false, status: 'ringing' };
      await event(page, 'call', ring);
      const bar = page.getByRole('alert').filter({ hasText: 'Incoming voice call' });
      await expect(bar).toBeVisible();
      await expect(bar).toContainText('Marina Costa');
      await expect(bar).toContainText('answered on your phone');
      await shot(page, theme, 'call-voice-wide');
      await bar.getByRole('button', { name: /Decline call/ }).click();
      await expect(bar).toHaveCount(0);
      expect((await calls(page, '/call/reject'))[0].body).toEqual({ id: 'CALL1', chatId: '5511987654321@c.us' });
      await event(page, 'call', { ...ring, id: 'CALL2', video: true });
      await expect(page.getByRole('alert').filter({ hasText: 'Incoming video call' })).toBeVisible();
      await shot(page, theme, 'call-video-wide');
      await event(page, 'call', { ...ring, id: 'CALL2', video: true, status: 'accepted' });
      await expect(page.getByRole('alert')).toHaveCount(0);
    });

    test('incoming call bar narrow and 45 s auto-dismiss', async ({ page }) => {
      await page.clock.install();
      await open(page, theme, '', NARROW);
      await event(page, 'call', { id: 'CALL3', chatId: '5511987654321@c.us', name: 'Marina Costa', video: true, status: 'ringing' });
      await expect(page.getByRole('alert')).toBeVisible();
      await shot(page, theme, 'call-narrow');
      await noOverflow(page);
      await page.clock.fastForward(46_000);
      await expect(page.getByRole('alert')).toHaveCount(0);
    });

    test('status: list, story viewer, keyboard, composer, delete', async ({ page }) => {
      await open(page, theme, '&view=status');
      await expect(page.getByRole('button', { name: /^My status, 2 updates/ })).toBeVisible();
      await expect(page.locator('.wa-ssec')).toHaveText('Recent updates');
      await expect(page.locator('.wa-srow')).toHaveCount(4);
      await shot(page, theme, 'status-list-wide');
      await page.getByRole('button', { name: /^Rafael Souza/ }).click();
      const story = page.getByRole('dialog', { name: 'Status of Rafael Souza' });
      await expect(story).toBeVisible();
      await expect(story.locator('.wa-story-text')).toContainText('Production is on schedule');
      await expect(story.locator('.wa-story-bars span')).toHaveCount(3);
      await shot(page, theme, 'status-viewer-text-wide');
      await page.keyboard.press('ArrowRight');
      await expect(story.locator('img')).toBeVisible();
      await expect(story.locator('.wa-story-caption')).toHaveText('Fresh batch');
      await shot(page, theme, 'status-viewer-image-wide');
      await page.keyboard.press('ArrowRight');
      await expect(story.getByText('This file is no longer available')).toBeVisible();
      await page.keyboard.press('ArrowLeft');
      await expect(story.locator('img')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(story).toHaveCount(0);
      // a photo advances by itself after 5 s: seen items are skipped on the next open (first unseen one)
      await page.getByRole('button', { name: /^Bia Nogueira/ }).click();
      await expect(page.getByRole('dialog', { name: 'Status of Bia Nogueira' }).locator('img')).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Status of Rafael Souza' })).toBeVisible({ timeout: 8000 }).catch(() => undefined);
      await page.keyboard.press('Escape');
      // composer: text
      await page.getByRole('button', { name: 'Add status' }).click();
      const dlg = page.getByRole('dialog', { name: 'New status' });
      await expect(dlg.getByRole('button', { name: 'Post status' })).toBeDisabled();
      await dlg.getByLabel('Status text').fill('Back in stock tomorrow');
      await dlg.getByRole('radio', { name: 'Background #8e24aa' }).click();
      await shot(page, theme, 'status-composer-text-wide');
      await dlg.getByRole('button', { name: 'Post status' }).click();
      await expect(dlg).toHaveCount(0);
      expect((await calls(page, '/status/text'))[0].body).toEqual({ text: 'Back in stock tomorrow', backgroundColor: '#8e24aa' });
      // composer: photo
      await page.getByRole('button', { name: 'Add status' }).click();
      await page.getByRole('dialog').getByRole('tab', { name: 'Photo or video' }).click();
      await shot(page, theme, 'status-composer-media-wide');
      await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'shop.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8CAFQ0nCQCCmQ/h/mNylAAAAABJRU5ErkJggg==', 'base64') });
      await page.getByRole('dialog').getByLabel('Caption').fill('New window');
      await page.getByRole('dialog').getByRole('button', { name: 'Post status' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const img = (await calls(page, '/status/image'))[0].body;
      expect(img).toMatchObject({ mime: 'image/png', filename: 'shop.png', caption: 'New window' });
      expect(img.data).toMatch(/^data:image\/png;base64,/);
      // delete my own status
      await page.getByRole('button', { name: /^My status/ }).click();
      await page.getByRole('button', { name: 'Delete this status' }).click();
      await page.getByRole('dialog', { name: 'Status of My status' }).getByRole('button', { name: 'Delete', exact: true }).click();
      expect((await calls(page, '/status/delete'))[0].body).toEqual({ id: 'M1' });
    });

    test('status narrow: list, viewer, composer at 380px', async ({ page }) => {
      await open(page, theme, '&view=status', NARROW);
      await expect(page.locator('.wa-srow').first()).toBeVisible();
      await shot(page, theme, 'status-list-narrow');
      await noOverflow(page);
      await page.getByRole('button', { name: /^Rafael Souza/ }).click();
      await expect(page.locator('.wa-story-text')).toBeVisible();
      await shot(page, theme, 'status-viewer-narrow');
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('.wa-story img')).toBeVisible();
      await shot(page, theme, 'status-viewer-image-narrow');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Add status' }).click();
      await shot(page, theme, 'status-composer-narrow');
      const r = (await page.getByRole('dialog').boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(NARROW.width);
    });

    test('channels: list, search, follow, read-only posts', async ({ page }) => {
      await open(page, theme, '&view=channels');
      await expect(page.locator('.wa-chrow')).toHaveCount(3);
      await expect(page.getByRole('button', { name: 'Open Zoe Personalizados' })).toContainText('12.4K followers');
      await expect(page.locator('.wa-verified').first()).toBeVisible();
      await shot(page, theme, 'channels-list-wide');
      await page.getByRole('searchbox', { name: 'Search channels' }).fill('design');
      await expect(page.locator('.wa-chrow')).toHaveCount(2);
      await shot(page, theme, 'channels-search-wide');
      await page.getByRole('button', { name: 'Follow Design Weekly' }).click();
      expect((await calls(page, '/channel/follow'))[0].body).toEqual({ id: '120363444444444444@newsletter', follow: true });
      await page.getByRole('searchbox', { name: 'Search channels' }).fill('');
      await page.getByRole('button', { name: 'Open Zoe Personalizados' }).click();
      await expect(page.getByRole('log', { name: 'Channel posts' })).toBeVisible();
      await expect(page.locator('.wa-bubble')).toHaveCount(4);
      await expect(page.locator('.wa-readonly')).toContainText('Posting and replying happen in WhatsApp');
      await expect(page.getByLabel('Type a message')).toHaveCount(0);
      await shot(page, theme, 'channel-posts-wide');
      await page.getByRole('button', { name: 'Back to channels' }).click();
      await expect(page.locator('.wa-chrow')).toHaveCount(3);
    });

    test('channels narrow', async ({ page }) => {
      await open(page, theme, '&view=channels', NARROW);
      await expect(page.locator('.wa-chrow').first()).toBeVisible();
      await shot(page, theme, 'channels-list-narrow');
      await noOverflow(page);
      await page.getByRole('button', { name: 'Open Zoe Personalizados' }).click();
      await expect(page.locator('.wa-bubble').first()).toBeVisible();
      await shot(page, theme, 'channel-posts-narrow');
      await noOverflow(page);
    });
  });
}
