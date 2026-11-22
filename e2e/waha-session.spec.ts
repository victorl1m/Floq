// The WAHA plugin connection screen (QR + pairing code login), reconnect bar and account menu, mounted from the plugin's BUILT package.
// Screenshots go to the Artifacts folder: waha-full-session-<theme>-<state>.png.
//   WAHA_PLUGIN_DIR=checkout  (after npm run build there)   WAHA_SHOTS=dir
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const pluginDir = process.env.WAHA_PLUGIN_DIR ?? path.resolve(process.env.HOME ?? '.', 'work/floq-plugin-waha');
const dist = path.join(pluginDir, 'dist');
const pkgFile = existsSync(dist) ? readdirSync(dist).find((f) => /^waha-.*\.floqpkg\.json$/.test(f)) : undefined;
const shots = process.env.WAHA_SHOTS ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
test.skip(!pkgFile, 'no built WAHA plugin package: set WAHA_PLUGIN_DIR and run npm run build there');

const WIDE = { width: 1100, height: 760 }, NARROW = { width: 380, height: 760 };
async function open(page: Page, theme: string, query: Record<string, string>, size = WIDE) {
  await page.setViewportSize(size);
  await page.route('**/__waha/pkg.json', (route) => route.fulfill({ contentType: 'application/json', body: readFileSync(path.join(dist, pkgFile!), 'utf8') }));
  const q = new URLSearchParams({ demo: 'session', ...query, ...(theme === 'dark' ? { theme: 'dark' } : {}) });
  await page.goto('/e2e/harness/waha-session.html?' + q);
}
async function shot(page: Page, theme: string, name: string) {
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `waha-full-session-${theme}-${name}.png`) });
}
const noOverflow = (page: Page) => page.evaluate(() => { const r = document.querySelector('.wa-root')!; return r.scrollWidth <= r.clientWidth + 1; });
const calls = (page: Page, p: string) => page.evaluate((x) => (window as unknown as { __calls: Array<{ path: string; body: unknown }> }).__calls.filter((c) => c.path === x), p);

for (const theme of ['light', 'dark']) {
  for (const [sizeName, size] of [['wide', WIDE], ['narrow', NARROW]] as const) {
    test.describe(`${theme} ${sizeName}`, () => {
      const tag = (s: string) => `${s}${sizeName === 'narrow' ? '-narrow' : ''}`;

      test('QR login: steps, 264px QR on white, no overflow, refreshes on events', async ({ page }) => {
        await open(page, theme, { view: 'screen', status: 'SCAN_QR_CODE' }, size);
        const qr = page.locator('.wa-qr-box svg');
        await expect(qr).toBeVisible();
        const box = (await qr.boundingBox())!;
        expect(Math.round(box.width)).toBe(sizeName === 'wide' ? 264 : Math.round(box.width));
        expect(box.width).toBeLessThanOrEqual(264);
        expect(Math.abs(box.width - box.height)).toBeLessThan(1);
        // always dark on white, also in the dark theme
        expect(await page.locator('.wa-qr-box').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
        await expect(page.getByText('Open WhatsApp on your phone')).toBeVisible();
        await expect(page.getByText('Link a device', { exact: false }).first()).toBeVisible();
        await expect(page.getByRole('button', { name: 'Link with phone number instead' })).toBeVisible();
        expect(await noOverflow(page)).toBe(true);
        const before = await page.locator('.wa-qr-box svg path').getAttribute('d');
        await page.evaluate(() => (window as unknown as { __set: (s: string) => void }).__set('SCAN_QR_CODE'));
        await expect.poll(async () => page.locator('.wa-qr-box svg path').getAttribute('d')).not.toBe(before);
        await shot(page, theme, tag('qr'));
      });

      test('pairing code: phone prefilled, code in 8 boxes, back to QR', async ({ page }) => {
        await open(page, theme, { view: 'screen', status: 'SCAN_QR_CODE' }, size);
        await page.getByRole('button', { name: 'Link with phone number instead' }).click();
        await expect(page.getByLabel('Phone number')).toHaveValue('+5511987654321');
        await shot(page, theme, tag('pair-form'));
        await page.getByRole('button', { name: 'Get code' }).click();
        await expect(page.locator('.wa-code-box')).toHaveCount(8);
        expect((await page.locator('.wa-code-box').allTextContents()).join('')).toBe('WXYZ1234');
        expect((await calls(page, '/session/pair-code'))[0].body).toEqual({ phone: '+5511987654321' });
        expect(await noOverflow(page)).toBe(true);
        for (const b of await page.locator('.wa-code-box').all()) expect((await b.boundingBox())!.width).toBeGreaterThan(24);
        await shot(page, theme, tag('pair-code'));
        await page.getByRole('button', { name: 'Link with QR code instead' }).click();
        await expect(page.locator('.wa-qr-box svg')).toBeVisible();
      });

      test('pairing code: a bad number shows the error inline', async ({ page }) => {
        await open(page, theme, { view: 'screen', status: 'SCAN_QR_CODE' }, size);
        await page.getByRole('button', { name: 'Link with phone number instead' }).click();
        await page.getByLabel('Phone number').fill('12');
        await page.getByRole('button', { name: 'Get code' }).click();
        await expect(page.getByRole('alert')).toContainText('Pick the country');
      });

      for (const [status, heading, name] of [
        ['UNREACHABLE', 'Cannot reach WAHA', 'unreachable'], ['UNAUTHORIZED', 'WAHA refused the API key', 'unauthorized'], ['MISSING', 'Connect WhatsApp', 'missing'],
        ['STARTING', 'Starting WhatsApp', 'starting'], ['FAILED', 'The connection failed', 'failed'], ['PASSKEY_REQUIRED', 'Passkey needed', 'passkey'],
      ] as const) {
        test(`state ${status}`, async ({ page }) => {
          await open(page, theme, { view: 'screen', status }, size);
          await expect(page.getByRole('heading', { name: heading })).toBeVisible();
          expect(await noOverflow(page)).toBe(true);
          await shot(page, theme, tag(name));
        });
      }

      test('no session with that name: lists the sessions of WAHA, attaches one, or creates a new one', async ({ page }) => {
        await open(page, theme, { view: 'screen', status: 'MISSING' }, size);
        await expect(page.getByRole('button', { name: /loja.*Zoe Shop.*Connected/ })).toBeVisible();
        await expect(page.getByLabel(/create a new session/)).toHaveValue('default');
        expect(await noOverflow(page)).toBe(true);
        await shot(page, theme, tag('pick-session'));
        await page.getByLabel(/create a new session/).fill('nova');
        await page.getByRole('button', { name: 'Create and connect' }).click();
        await expect(page.getByRole('heading', { name: 'Starting WhatsApp' })).toBeVisible();
        expect((await calls(page, '/session/use')).map((c) => c.body)).toEqual([{ name: 'nova' }]);
        expect((await calls(page, '/session/start')).length).toBe(1);
        await page.evaluate(() => (window as unknown as { __set: (s: string) => void }).__set('MISSING'));
        await page.getByRole('button', { name: /loja/ }).click();
        await expect.poll(async () => (await calls(page, '/session/use')).length).toBe(2);
        expect((await calls(page, '/session/start')).length).toBe(1);
      });

      test('Connect WhatsApp creates the session, then the QR appears and the screen hands over when WORKING', async ({ page }) => {
        await open(page, theme, { view: 'screen', status: 'STOPPED' }, size);
        await page.getByRole('button', { name: 'Connect WhatsApp' }).click();
        await expect(page.getByRole('heading', { name: 'Starting WhatsApp' })).toBeVisible();
        expect((await calls(page, '/session/start')).length).toBe(1);
        await page.evaluate(() => (window as unknown as { __set: (s: string) => void }).__set('SCAN_QR_CODE'));
        await expect(page.locator('.wa-qr-box svg')).toBeVisible();
        await page.evaluate(() => (window as unknown as { __set: (s: string) => void }).__set('WORKING'));
        await expect(page.locator('.wa-sess')).toHaveCount(0);
        await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
      });

      test('FAILED: Try again restarts', async ({ page }) => {
        await open(page, theme, { view: 'screen', status: 'FAILED' }, size);
        await page.getByRole('button', { name: 'Try again' }).click();
        await expect(page.getByRole('heading', { name: 'Starting WhatsApp' })).toBeVisible();
        expect((await calls(page, '/session/restart')).length).toBe(1);
      });

      test('reconnect bar: dropped session, Reconnect, live status', async ({ page }) => {
        await open(page, theme, { view: 'inbox', status: 'WORKING' }, size);
        await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
        await expect(page.locator('.wa-sbar')).toHaveCount(0);
        await page.evaluate(() => (window as unknown as { __set: (s: string) => void }).__set('STOPPED'));
        await expect(page.locator('.wa-sbar')).toContainText('Phone not connected');
        expect(await noOverflow(page)).toBe(true);
        await shot(page, theme, tag('bar-stopped'));
        await page.getByRole('button', { name: 'Reconnect' }).click();
        await expect(page.locator('.wa-sbar')).toContainText('Reconnecting');
        await shot(page, theme, tag('bar-starting'));
        await page.evaluate(() => (window as unknown as { __set: (s: string) => void }).__set('WORKING'));
        await expect(page.locator('.wa-sbar')).toHaveCount(0);
      });

      test('reconnect bar: unreachable and unlinked', async ({ page }) => {
        await open(page, theme, { view: 'inbox', status: 'WORKING' }, size);
        await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
        await page.evaluate(() => (window as unknown as { __set: (s: string) => void }).__set('UNREACHABLE'));
        await expect(page.locator('.wa-sbar')).toContainText('Cannot reach WAHA');
        await shot(page, theme, tag('bar-unreachable'));
        await page.evaluate(() => (window as unknown as { __set: (s: string) => void }).__set('SCAN_QR_CODE'));
        await expect(page.getByRole('button', { name: 'Link again' })).toBeVisible();
        await page.getByRole('button', { name: 'Link again' }).click();
        await expect(page.locator('.wa-qr-box svg')).toBeVisible();
      });

      test('account menu: name, engine, status dot, actions, logout confirm', async ({ page }) => {
        await open(page, theme, { view: 'inbox', status: 'WORKING', webhook: 'missing' }, size);
        const trigger = page.getByRole('button', { name: /WhatsApp account: Zoe Personalizações, Connected/ });
        await expect(trigger).toBeVisible();
        await expect(page.locator('.wa-dot')).toHaveAttribute('data-s', 'WORKING');
        await trigger.click();
        const menu = page.getByRole('menu');
        await expect(menu).toContainText('Zoe Personalizações');
        await expect(menu).toContainText('WEBJS');
        for (const item of ['Restart', 'Stop', 'Screenshot', 'Fix webhook events', 'Log out']) await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
        await shot(page, theme, tag('menu'));
        await page.getByRole('menuitem', { name: 'Log out' }).click();
        await expect(page.getByRole('alertdialog')).toContainText('unlinks the phone');
        await shot(page, theme, tag('logout-confirm'));
        await page.getByRole('button', { name: 'Cancel' }).click();
        expect((await calls(page, '/session/logout')).length).toBe(0);
        await trigger.click();
        await page.getByRole('menuitem', { name: 'Log out' }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Log out' }).click();
        await expect.poll(async () => (await calls(page, '/session/logout')).length).toBe(1);
        // the phone is unlinked: the bar offers the connection screen
        await expect(page.getByRole('button', { name: 'Link again' })).toBeVisible();
      });

      test('account menu: Fix webhook events asks first and sends one request', async ({ page }) => {
        await open(page, theme, { view: 'inbox', status: 'WORKING', webhook: 'missing' }, size);
        await page.getByRole('button', { name: /WhatsApp account/ }).click();
        await page.getByRole('menuitem', { name: 'Fix webhook events' }).click();
        const dlg = page.getByRole('alertdialog');
        await expect(dlg).toContainText('reconnects for a few seconds');
        await shot(page, theme, tag('webhook-confirm'));
        await dlg.getByRole('button', { name: 'Add events and reconnect' }).click();
        await expect(dlg).toHaveCount(0);
        expect((await calls(page, '/session/webhook-events')).length).toBe(1);
        await page.getByRole('button', { name: /WhatsApp account/ }).click();
        await expect(page.getByRole('menuitem', { name: 'Fix webhook events' })).toHaveCount(0);
      });

      test('account menu: environment webhook lists the events to enable; NOWEB hides Screenshot', async ({ page }) => {
        await open(page, theme, { view: 'inbox', status: 'WORKING', webhook: 'env', engine: 'NOWEB' }, size);
        await page.getByRole('button', { name: /WhatsApp account/ }).click();
        await expect(page.getByRole('menuitem', { name: 'Screenshot' })).toHaveCount(0);
        await page.getByRole('menuitem', { name: 'Webhook events' }).click();
        await expect(page.getByRole('alertdialog')).toContainText('message.any');
        await shot(page, theme, tag('webhook-env'));
      });

      test('account menu: Stop and screenshot', async ({ page }) => {
        await open(page, theme, { view: 'inbox', status: 'WORKING' }, size);
        await page.getByRole('button', { name: /WhatsApp account/ }).click();
        await page.getByRole('menuitem', { name: 'Screenshot' }).click();
        await expect(page.getByRole('alertdialog').locator('img')).toBeVisible();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Close' }).click();
        await page.getByRole('button', { name: /WhatsApp account/ }).click();
        await page.getByRole('menuitem', { name: 'Stop' }).click();
        await expect(page.locator('.wa-sbar')).toContainText('Phone not connected');
        expect((await calls(page, '/session/stop')).length).toBe(1);
      });
    });
  }
}
