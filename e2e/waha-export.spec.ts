// Exporting WhatsApp chats from the built-in inbox: the "Export chat" entries (chat menu, contact info, group info), the dialog and what it asks the runtime
// for, saving on the desktop (Tauri download_with_picker) and in a browser (a download), and "Export all chats" in the account menu. Light and dark.
// WAHA_SHOTS=dir  (default: the Artifacts folder)
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const shots = process.env.WAHA_SHOTS ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
type Dl = { id: string; path: string; query: Record<string, string> };
const downloads = (page: Page) => page.evaluate(() => ((window as unknown as { __downloads?: Dl[] }).__downloads ?? []));

/** desktop: a Tauri bridge that records invokes and answers download_with_picker with a saved path (or null = the user cancelled). */
async function desktop(page: Page, saved: string | null = '/home/me/Downloads/WhatsApp Chat - Marina Costa.zip') {
  await page.addInitScript((answer) => {
    const w = window as unknown as Record<string, any>;
    w.__invokes = [];
    w.isTauri = true;
    w.__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: (s: string) => s,
      async invoke(cmd: string, args: unknown) { w.__invokes.push({ cmd, args }); return cmd === 'download_with_picker' ? answer : cmd === 'plugin:event|listen' ? 1 : null; },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  }, saved);
}
const invokes = (page: Page) => page.evaluate(() => ((window as unknown as { __invokes: Array<{ cmd: string; args: any }> }).__invokes ?? []).filter((c) => c.cmd === 'download_with_picker'));

async function shot(page: Page, theme: string, name: string) {
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `waha-export-${theme}-${name}.png` ) });
}
async function people(page: Page, theme: string, chat: string, locale?: string) {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/e2e/harness/waha-people.html?demo=people' + (theme === 'dark' ? '&theme=dark' : ''));
  await expect(page.locator('.wa-row').first()).toBeVisible();
  await page.locator('.wa-row', { hasText: chat }).click();
}

for (const theme of ['light', 'dark']) {
  test.describe(theme, () => {
    test('chat header menu: Export chat opens the dialog; media off by default, a plain .txt asked for, saved with the desktop picker', async ({ page }) => {
      await desktop(page, '/home/me/Downloads/WhatsApp Chat - Marina Costa.txt');
      await people(page, theme, 'Marina Costa');
      await page.getByRole('button', { name: /^Menu of Marina Costa/ }).last().click();
      await page.getByRole('menuitem', { name: 'Export chat' }).click();
      const dlg = page.getByRole('dialog', { name: 'Export chat' });
      await expect(dlg).toBeVisible();
      await expect(dlg.getByText('Save “Marina Costa” as a WhatsApp chat export')).toBeVisible();
      await expect(dlg.getByRole('switch', { name: 'Include media' })).not.toBeChecked();
      await expect(dlg.getByRole('switch', { name: 'Include originals of deleted messages' })).not.toBeChecked();
      await expect(dlg.getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true');
      await expect(dlg.getByText('You get a .txt file.')).toBeVisible();
      await shot(page, theme, 'dialog');
      await dlg.getByRole('button', { name: 'Export' }).click();
      await expect(dlg).toBeHidden();
      const [dl] = await downloads(page);
      expect(dl.id).toBe('waha'); expect(dl.path).toBe('/export');
      expect(dl.query).toMatchObject({ chatId: '5511987654321@c.us', name: 'Marina Costa' });
      expect(dl.query.media).toBeUndefined(); expect(dl.query.transcript).toBeUndefined(); expect(dl.query.originals).toBeUndefined();
      expect(dl.query.locale).toBeTruthy(); expect(dl.query.tz).toBeTruthy();
      const [pick] = await invokes(page);
      expect(pick.args.fallbackName).toBe('WhatsApp Chat - Marina Costa.txt');
      expect(pick.args.url).toContain('/__export-test');
      await expect(page.getByText(/Saved WhatsApp Chat - Marina Costa.txt/)).toBeVisible();
    });

    test('options: media, transcript and originals change what is asked for and the file the dialog promises (.zip)', async ({ page }) => {
      await desktop(page);
      await people(page, theme, 'Marina Costa');
      await page.getByRole('button', { name: /^Menu of Marina Costa/ }).last().click();
      await page.getByRole('menuitem', { name: 'Export chat' }).click();
      const dlg = page.getByRole('dialog', { name: 'Export chat' });
      await dlg.getByRole('switch', { name: 'Include media' }).click();
      await dlg.getByRole('switch', { name: 'Include originals of deleted messages' }).click();
      await dlg.getByRole('button', { name: 'HTML' }).click();
      await expect(dlg.getByRole('button', { name: 'HTML' })).toHaveAttribute('aria-pressed', 'true');
      await expect(dlg.getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'false');
      await expect(dlg.getByText('You get a .zip file.')).toBeVisible();
      await shot(page, theme, 'dialog-options');
      await dlg.getByRole('button', { name: 'Markdown' }).click();
      await dlg.getByRole('button', { name: 'Export' }).click();
      const [dl] = await downloads(page);
      expect(dl.query).toMatchObject({ chatId: '5511987654321@c.us', media: '1', transcript: 'md', originals: '1' });
      expect((await invokes(page))[0].args.fallbackName).toBe('WhatsApp Chat - Marina Costa.zip');
    });

    test('desktop: cancelling the save dialog keeps the export dialog open and shows no success', async ({ page }) => {
      await desktop(page, null);
      await people(page, theme, 'Marina Costa');
      await page.getByRole('button', { name: /^Menu of Marina Costa/ }).last().click();
      await page.getByRole('menuitem', { name: 'Export chat' }).click();
      const dlg = page.getByRole('dialog', { name: 'Export chat' });
      await dlg.getByRole('button', { name: 'Export' }).click();
      await expect.poll(async () => (await invokes(page)).length).toBe(1);
      await expect(dlg).toBeVisible();
      await expect(dlg.getByRole('button', { name: 'Export' })).toBeEnabled();
      await expect(page.getByText(/^Saved /)).toHaveCount(0);
    });

    test('web: no Tauri, the signed link is followed as a browser download', async ({ page }) => {
      await people(page, theme, 'Marina Costa');
      await page.getByRole('button', { name: /^Menu of Marina Costa/ }).last().click();
      await page.getByRole('menuitem', { name: 'Export chat' }).click();
      const dlg = page.getByRole('dialog', { name: 'Export chat' });
      const nav = page.waitForEvent('download').catch(() => null);
      await page.route(/__export-test/, (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="chat.txt"' }, body: '[25/11/2026, 14:03:22] Marina: oi' }));
      await dlg.getByRole('button', { name: 'Export' }).click();
      const file = await nav;
      expect(file).not.toBeNull();
      expect(file!.url()).toContain('/__export-test?');
      expect(file!.url()).toContain('chatId=5511987654321%40c.us');
      await expect(page.getByText('Download started: WhatsApp Chat - Marina Costa.txt')).toBeVisible();
      await expect(dlg).toBeHidden();
    });

    test('contact info has Export chat', async ({ page }) => {
      await desktop(page);
      await people(page, theme, 'Marina Costa');
      await page.getByRole('button', { name: 'Contact info' }).click();
      const info = page.getByRole('complementary', { name: 'Contact info' });
      await info.getByRole('button', { name: 'Export chat' }).click();
      await expect(page.getByRole('dialog', { name: 'Export chat' })).toBeVisible();
      await shot(page, theme, 'contact-info');
      await page.getByRole('dialog', { name: 'Export chat' }).getByRole('button', { name: 'Export' }).click();
      expect((await downloads(page))[0].query.chatId).toBe('5511987654321@c.us');
    });

    test('group info has Export chat; the group name is the title', async ({ page }) => {
      await desktop(page, '/x/WhatsApp Chat - Equipe Zoe · Produção.txt');
      await people(page, theme, 'Equipe Zoe');
      await page.getByRole('button', { name: 'Group info' }).click();
      const info = page.getByRole('complementary', { name: 'Group info' });
      await info.getByRole('button', { name: 'Export chat' }).scrollIntoViewIfNeeded();
      await shot(page, theme, 'group-info');
      await info.getByRole('button', { name: 'Export chat' }).click();
      const dlg = page.getByRole('dialog', { name: 'Export chat' });
      await expect(dlg.getByText('Save “Equipe Zoe · Produção”')).toBeVisible();
      await dlg.getByRole('button', { name: 'Export' }).click();
      expect((await downloads(page))[0].query).toMatchObject({ chatId: '120363041234567890@g.us', name: 'Equipe Zoe · Produção' });
    });

    test('account menu: Export all chats asks for the whole account', async ({ page }) => {
      await desktop(page, '/x/WhatsApp Chats - Zoe.zip');
      await page.setViewportSize({ width: 900, height: 700 });
      await page.goto('/e2e/harness/waha-session.html?demo=session&view=inbox&status=WORKING' + (theme === 'dark' ? '&theme=dark' : ''));
      await page.getByRole('button', { name: /WhatsApp account/ }).click();
      await page.getByRole('menuitem', { name: 'Export all chats' }).click();
      const dlg = page.getByRole('dialog', { name: 'Export all chats' });
      await expect(dlg).toBeVisible();
      await expect(dlg.getByText('One zip with a folder per chat')).toBeVisible();
      await expect(dlg.getByText('You get a .zip file.')).toBeVisible();
      await shot(page, theme, 'all-chats');
      await dlg.getByRole('switch', { name: 'Include media' }).click();
      await dlg.getByRole('button', { name: 'Export' }).click();
      const [dl] = await downloads(page);
      expect(dl.path).toBe('/export');
      expect(dl.query).toMatchObject({ all: '1', media: '1' });
      expect(dl.query.chatId).toBeUndefined();
      expect((await invokes(page))[0].args.fallbackName).toMatch(/^WhatsApp Chats - .+\.zip$/);
    });
  });
}
