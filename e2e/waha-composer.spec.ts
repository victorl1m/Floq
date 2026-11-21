// The WAHA plugin composer (WhatsApp-Web-style message bar), driven in the real inbox from the plugin's BUILT package: mic/send morph, growth, Enter/IME,
// emoji picker, attach menu + tray, paste, drop, size cap, voice notes (fake microphone), reply/edit bars, mentions, 360px width, light and dark.
//   WAHA_PLUGIN_DIR=checkout  (after npm run build there)   WAHA_SHOTS=dir  (default: the Artifacts folder)
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const pluginDir = process.env.WAHA_PLUGIN_DIR ?? path.resolve(process.env.HOME ?? '.', 'work/floq-plugin-waha');
const dist = path.join(pluginDir, 'dist');
const pkgFile = existsSync(dist) ? readdirSync(dist).find((f) => /^waha-.*\.floqpkg\.json$/.test(f)) : undefined;
const shots = process.env.WAHA_SHOTS ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';

test.skip(!pkgFile, 'no built WAHA plugin package: set WAHA_PLUGIN_DIR and run npm run build there');
test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8CAFQ0nCQCCmQ/h/mNylAAAAABJRU5ErkJggg==', 'base64');

async function open(page: Page, chat: string, theme: string, size = { width: 1100, height: 760 }) {
  await page.setViewportSize(size);
  await page.route('**/__waha/pkg.json', (route) => route.fulfill({ contentType: 'application/json', body: readFileSync(path.join(dist, pkgFile!), 'utf8') }));
  await page.goto('/e2e/harness/waha-composer.html' + (theme === 'dark' ? '?theme=dark' : ''));
  await page.locator('.wa-row', { hasText: chat }).click();
  await expect(page.locator('.wa-composer')).toBeVisible();
  await expect(page.locator('.wa-msg').first()).toBeVisible();
}
async function shot(page: Page, theme: string, name: string) {
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shots, `waha-full-composer-${theme}-${name}.png`) });
}
const field = (page: Page) => page.locator('.wa-cfield textarea');
const action = (page: Page) => page.locator('.wa-action');
const sends = (page: Page, p: string) => page.evaluate((x) => (window as unknown as { __calls: Array<{ path: string; body: any }> }).__calls.filter((c) => c.path === x), p);
const filePayload = (page: Page, files: Array<{ name: string; type: string; data: number[] }>, targets: { type: 'paste' | 'drop'; sel: string }) =>
  page.evaluate(({ files, targets }) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([new Uint8Array(f.data)], f.name, { type: f.type }));
    const el = document.querySelector(targets.sel)!;
    if (targets.type === 'paste') el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    else {
      el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      (window as unknown as { __dropDt: DataTransfer }).__dropDt = dt;
    }
  }, { files, targets });

for (const theme of ['light', 'dark']) {
  test.describe(theme, () => {
    test('empty: mic, one 42-44px pill, 24px icons, no hint text', async ({ page }) => {
      await open(page, 'Marina Costa', theme);
      await expect(action(page)).toHaveAttribute('data-mode', 'mic');
      await expect(action(page)).toHaveAccessibleName('Record voice message');
      const box = await page.locator('.wa-cfield').boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(42);
      expect(box!.height).toBeLessThanOrEqual(44);
      for (const b of await page.locator('.wa-bar .wa-cbtn, .wa-bar .wa-action').all()) {
        const r = await b.boundingBox();
        expect(r!.width).toBeGreaterThanOrEqual(40);
        expect(r!.height).toBeGreaterThanOrEqual(40);
      }
      for (const svg of await page.locator('.wa-bar .wa-cbtn svg, .wa-action .wa-ico-mic svg').all()) expect((await svg.boundingBox())!.width).toBe(24);
      // the mic icon is the visible one, the send icon is faded out
      await expect(page.locator('.wa-ico-mic')).toHaveCSS('opacity', '1');
      await expect(page.locator('.wa-ico-send')).toHaveCSS('opacity', '0');
      // no native textarea chrome, no hint
      const s = await field(page).evaluate((e) => { const c = getComputedStyle(e); return { resize: c.resize, border: c.borderTopWidth, outline: c.outlineStyle, shadow: c.boxShadow }; });
      expect(s).toEqual({ resize: 'none', border: '0px', outline: 'none', shadow: 'none' });
      expect(await page.locator('.wa-composer').innerHTML()).not.toMatch(/Enter to send/i);
      expect(await field(page).getAttribute('title')).toBeNull();
      // placeholder is vertically centred in the pill
      const f = await field(page).boundingBox();
      expect(Math.abs((f!.y + f!.height / 2) - (box!.y + box!.height / 2))).toBeLessThanOrEqual(1);
      await shot(page, theme, 'empty');
    });

    test('typing morphs mic into send; the field grows to 6 lines, then scrolls', async ({ page }) => {
      await open(page, 'Marina Costa', theme);
      const h0 = (await field(page).boundingBox())!.height;
      await field(page).fill('Oi, tudo bem?');
      await expect(action(page)).toHaveAttribute('data-mode', 'send');
      await expect(action(page)).toHaveAccessibleName('Send message');
      await expect(page.locator('.wa-ico-send')).toHaveCSS('opacity', '1');
      expect((await field(page).boundingBox())!.height).toBe(h0);
      await shot(page, theme, 'typing');
      await field(page).fill(Array.from({ length: 4 }, (_, i) => 'linha ' + (i + 1)).join('\n'));
      const h4 = (await field(page).boundingBox())!.height;
      expect(h4).toBeGreaterThan(h0 + 40);
      await field(page).fill(Array.from({ length: 14 }, (_, i) => 'linha ' + (i + 1)).join('\n'));
      const h14 = (await field(page).boundingBox())!.height;
      expect(h14).toBeLessThanOrEqual(142);
      expect(await field(page).evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
      await shot(page, theme, 'multiline');
      await field(page).fill('');
      await expect(action(page)).toHaveAttribute('data-mode', 'mic');
    });

    test('Enter sends, Shift+Enter breaks the line, IME composition never sends', async ({ page }) => {
      await open(page, 'Marina Costa', theme);
      await field(page).fill('primeira');
      await field(page).press('Shift+Enter');
      await field(page).pressSequentially('segunda');
      expect(await field(page).inputValue()).toBe('primeira\nsegunda');
      expect(await sends(page, '/send')).toHaveLength(0);
      await field(page).evaluate((e) => e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
      expect(await sends(page, '/send')).toHaveLength(0);
      await field(page).press('Enter');
      await expect.poll(async () => (await sends(page, '/send')).length).toBe(1);
      expect((await sends(page, '/send'))[0].body).toEqual({ chatId: '5511987654321@c.us', text: 'primeira\nsegunda' });
      await expect(field(page)).toHaveValue('');
    });

    test('emoji picker: search, pick at the cursor, recents, keyboard', async ({ page }) => {
      await open(page, 'Marina Costa', theme);
      await field(page).fill('ab');
      await field(page).evaluate((e: HTMLTextAreaElement) => e.setSelectionRange(1, 1));
      await page.getByRole('button', { name: 'Emoji', exact: true }).click();
      const dlg = page.getByRole('dialog', { name: 'Emoji' });
      await expect(dlg).toBeVisible();
      await expect(dlg.getByRole('searchbox').or(dlg.getByLabel('Search emoji'))).toBeFocused();
      expect(await dlg.getByRole('tab').count()).toBeGreaterThanOrEqual(9);
      await shot(page, theme, 'emoji');
      await dlg.getByLabel('Search emoji').fill('pizza');
      await expect(dlg.locator('.wa-emoji-btn')).toHaveCount(1);
      await dlg.locator('.wa-emoji-btn').click();
      await expect(field(page)).toHaveValue('a🍕b');
      await expect(field(page)).toBeFocused();
      expect(await field(page).evaluate((e: HTMLTextAreaElement) => e.selectionStart)).toBe(3);
      expect(await page.evaluate(() => localStorage.getItem('waha.recentEmoji'))).toBe('["🍕"]');
      // reopened: recents come first
      await page.keyboard.press('Escape');
      await expect(dlg).toBeHidden();
      await page.getByRole('button', { name: 'Emoji', exact: true }).click();
      await expect(dlg.locator('section').first()).toHaveAttribute('data-sec', 'recent');
      await expect(dlg.locator('section').first().locator('.wa-emoji-btn')).toHaveText(['🍕']);
      // keyboard: search -> grid -> Enter inserts, Esc closes and returns focus to the button
      await dlg.getByLabel('Search emoji').fill('smile');
      await page.keyboard.press('ArrowDown');
      await expect(dlg.locator('.wa-emoji-btn').first()).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await expect(field(page)).toBeFocused();
      expect((await field(page).inputValue()).length).toBeGreaterThan(4);
      await page.getByRole('button', { name: 'Emoji', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(dlg).toBeHidden();
      await expect(page.getByRole('button', { name: 'Emoji', exact: true })).toBeFocused();
    });

    test('attach menu, file chooser, tray, caption, send, remove', async ({ page }) => {
      await open(page, 'Marina Costa', theme);
      await page.getByRole('button', { name: 'Attach', exact: true }).click();
      const menu = page.getByRole('menu', { name: 'Attach' });
      await expect(menu.getByRole('menuitem')).toHaveText(['Photos & videos', 'Document', 'Camera', 'Poll', 'Location', 'Contact']);
      await shot(page, theme, 'attach-menu');
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menu.getByRole('menuitem', { name: 'Photos & videos' }).click()]);
      await chooser.setFiles([
        { name: 'bolo.png', mimeType: 'image/png', buffer: PNG },
        { name: 'orcamento-festa-40-canecas.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(120_000, 1) },
      ]);
      await expect(page.locator('.wa-att')).toHaveCount(2);
      await expect(page.locator('.wa-att img')).toHaveCount(1);
      await expect(page.locator('.wa-att-chip')).toContainText('orcamento-festa-40-canecas.pdf');
      await expect(page.locator('.wa-att-chip')).toContainText('117 KB');
      await expect(field(page)).toHaveAttribute('placeholder', 'Add a caption');
      await expect(action(page)).toHaveAttribute('data-mode', 'send'); // attachments alone turn the mic into send
      await shot(page, theme, 'tray');
      await page.getByRole('button', { name: 'Remove bolo.png' }).click();
      await expect(page.locator('.wa-att')).toHaveCount(1);
      await field(page).fill('Segue o orçamento');
      await field(page).press('Enter');
      await expect.poll(async () => (await sends(page, '/send-media')).length).toBe(1);
      const body = (await sends(page, '/send-media'))[0].body;
      expect(body.text).toBe('Segue o orçamento');
      expect(body.files).toEqual([{ name: 'orcamento-festa-40-canecas.pdf', mime: 'application/pdf', bytes: 120000, kind: 'document' }]);
      await expect(page.locator('.wa-att')).toHaveCount(0);
      await expect(action(page)).toHaveAttribute('data-mode', 'mic');
    });

    test('paste: an image becomes an attachment, text stays text', async ({ page }) => {
      await open(page, 'Marina Costa', theme);
      await field(page).focus();
      await filePayload(page, [{ name: '', type: 'image/png', data: [...PNG] }], { type: 'paste', sel: '.wa-cfield textarea' });
      await expect(page.locator('.wa-att img')).toHaveCount(1);
      await field(page).fill('');
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/plain', 'só texto');
        document.querySelector('.wa-cfield textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await expect(page.locator('.wa-att')).toHaveCount(1);
    });

    test('drop: overlay over the pane, files land in the tray', async ({ page }) => {
      await open(page, 'Marina Costa', theme);
      await filePayload(page, [{ name: 'contrato.pdf', type: 'application/pdf', data: [1, 2, 3, 4] }], { type: 'drop', sel: '.wa-chat-pane' });
      await expect(page.getByText('Drop files to send')).toBeVisible();
      const pane = await page.locator('.wa-chat-pane').boundingBox(), over = await page.locator('.wa-drop').boundingBox();
      expect(over).toEqual(pane);
      await shot(page, theme, 'drop');
      await page.evaluate(() => {
        const dt = (window as unknown as { __dropDt: DataTransfer }).__dropDt;
        document.querySelector('.wa-chat-pane')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      });
      await expect(page.getByText('Drop files to send')).toBeHidden();
      await expect(page.locator('.wa-att-chip')).toContainText('contrato.pdf');
    });

    test('files over 3.5 MiB are refused with a toast naming the file and the limit', async ({ page }) => {
      await open(page, 'Marina Costa', theme);
      await page.getByRole('button', { name: 'Attach', exact: true }).click();
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Document' }).click()]);
      await chooser.setFiles([{ name: 'filme-grande.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(4 * 1024 * 1024) }, { name: 'ok.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }]);
      const toast = page.locator('[data-sonner-toast]').first();
      await expect(toast).toContainText('filme-grande.mp4');
      await expect(toast).toContainText('3.5 MB');
      await expect(page.locator('.wa-att')).toHaveCount(1);
      await expect(page.locator('.wa-att-chip')).toContainText('ok.txt');
    });

    test('voice note: record UI, cancel, then record and send', async ({ page }) => {
      await open(page, 'Marina Costa', theme);
      await action(page).click();
      const rec = page.locator('.wa-rec');
      await expect(rec).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel recording' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send voice message' })).toBeVisible();
      await expect(page.locator('.wa-rec-time')).toHaveText('0:01', { timeout: 4000 });
      await expect.poll(() => page.locator('.wa-rec-bars i').evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().height)))).toBeGreaterThan(3);
      await shot(page, theme, 'recording');
      await page.getByRole('button', { name: 'Cancel recording' }).click();
      await expect(rec).toBeHidden();
      await expect(action(page)).toHaveAttribute('data-mode', 'mic');
      expect(await sends(page, '/send-voice')).toHaveLength(0);
      // Esc cancels too
      await action(page).click();
      await expect(rec).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(rec).toBeHidden();
      // record and send
      await action(page).click();
      await expect(page.locator('.wa-rec-time')).toHaveText('0:01', { timeout: 4000 });
      await page.getByRole('button', { name: 'Send voice message' }).click();
      await expect.poll(async () => (await sends(page, '/send-voice')).length).toBe(1);
      const b = (await sends(page, '/send-voice'))[0].body;
      expect(b.mime).toMatch(/^audio\/(ogg|webm|mp4)/);
      expect(b.bytes).toBeGreaterThan(0);
      expect(b.durationMs).toBeGreaterThan(900);
      await expect(page.locator('.wa-rec')).toBeHidden();
    });

    test('reply bar and edit bar', async ({ page }) => {
      await open(page, 'Marina Costa', theme);
      const msg = page.locator('.wa-msg', { hasText: 'Pode confirmar o endereço' });
      await msg.hover();
      await msg.getByRole('button', { name: 'Reply' }).click();
      const bar = page.locator('.wa-replybar');
      await expect(bar).toContainText('Marina Costa');
      await expect(bar).toContainText('Pode confirmar o endereço');
      await expect(field(page)).toBeFocused();
      await shot(page, theme, 'reply');
      await page.keyboard.press('Escape');
      await expect(bar).toBeHidden();
      await page.evaluate(() => (window as unknown as { __waEdit: (id: string, b: string) => void }).__waEdit('m6', 'Dá sim. 40 unidades com gravação'));
      await expect(page.locator('.wa-replybar')).toContainText('Edit message');
      await expect(field(page)).toHaveValue('Dá sim. 40 unidades com gravação');
      await expect(action(page)).toHaveAccessibleName('Save edit');
      expect(await page.locator('.wa-ico-send svg').first().evaluate((e) => !!e.closest('.wa-ico-send'))).toBe(true);
      await shot(page, theme, 'edit');
      await page.keyboard.press('Escape');
      await expect(page.locator('.wa-replybar')).toBeHidden();
      await expect(field(page)).toHaveValue('');
    });

    test('mentions in a group: list, arrows, Enter picks, Esc closes', async ({ page }) => {
      await open(page, 'Equipe Zoe', theme);
      await field(page).fill('oi @');
      const list = page.getByRole('listbox', { name: 'Mention someone' });
      await expect(list.getByRole('option')).toHaveCount(3);
      await shot(page, theme, 'mentions');
      await field(page).press('ArrowDown');
      await expect(list.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
      await field(page).press('Enter');
      expect(await field(page).inputValue()).toMatch(/^oi @\d+ $/);
      expect(await sends(page, '/send')).toHaveLength(0);
      await field(page).fill('oi @r');
      await expect(list.getByRole('option')).toHaveCount(1);
      await expect(list).toContainText('Rafael Souza');
      await field(page).press('Escape');
      await expect(list).toBeHidden();
      // a 1:1 chat has no mention list
      await field(page).fill('');
    });

    test('360px wide: nothing overflows, with tray, reply bar and recording', async ({ page }) => {
      await open(page, 'Marina Costa', theme, { width: 360, height: 700 });
      await shot(page, theme, 'narrow-empty');
      const fits = async (label: string) => {
        const bad = await page.evaluate(() => {
          const c = document.querySelector('.wa-composer')!.getBoundingClientRect(), out: string[] = [];
          document.querySelectorAll('.wa-composer *').forEach((e) => {
            const r = e.getBoundingClientRect();
            if (r.width && (r.left < c.left - 0.5 || r.right > c.right + 0.5) && !e.closest('.wa-tray')) out.push(e.className + ' ' + Math.round(r.left) + '-' + Math.round(r.right));
          });
          const root = document.querySelector('.wa-root')!;
          if (root.scrollWidth > root.clientWidth) out.push('root scrolls');
          return out;
        });
        expect(bad, label).toEqual([]);
      };
      await fits('empty');
      await field(page).fill('Mensagem bem comprida para forçar a quebra de linha dentro do campo estreito no celular, até passar de várias linhas de texto');
      await page.getByRole('button', { name: 'Attach', exact: true }).click();
      await shot(page, theme, 'narrow-menu');
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Document' }).click()]);
      await chooser.setFiles([{ name: 'um-nome-de-arquivo-muito-muito-comprido-orcamento-final.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2000) }]);
      await page.locator('.wa-msg', { hasText: 'Pode confirmar o endereço' }).hover();
      await page.locator('.wa-msg', { hasText: 'Pode confirmar o endereço' }).getByRole('button', { name: 'Reply' }).click({ force: true });
      await fits('tray + reply + long text');
      await shot(page, theme, 'narrow-full');
      await field(page).fill('');
      await page.locator('.wa-att-x').click();
      await page.getByRole('button', { name: 'Cancel reply' }).click();
      await action(page).click();
      await expect(page.locator('.wa-rec')).toBeVisible();
      await fits('recording');
      await shot(page, theme, 'narrow-recording');
    });
  });
}
