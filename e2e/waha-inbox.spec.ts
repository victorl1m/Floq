// The WhatsApp (WAHA) plugin inbox, rendered from the plugin's BUILT package exactly as an installed plugin loads: the app's shared
// runtime global plus a Blob import of the bundle. The plugin lives in its own repository; point WAHA_PLUGIN_DIR at its checkout
// (after `npm run build` there). Without a built package the tests are skipped.
//   WAHA_SHOTS=dir   also writes screenshots (waha-ui-*.png) into that directory
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const pluginDir = process.env.WAHA_PLUGIN_DIR ?? path.resolve(process.env.HOME ?? '.', 'work/floq-plugin-waha');
const dist = path.join(pluginDir, 'dist');
const pkgFile = existsSync(dist) ? readdirSync(dist).find((f) => /^waha-.*\.floqpkg\.json$/.test(f)) : undefined;
const shots = process.env.WAHA_SHOTS;

test.skip(!pkgFile, 'no built WAHA plugin package: set WAHA_PLUGIN_DIR and run npm run build there');

async function open(page: Page, query = '', size = { width: 1100, height: 760 }) {
  await page.setViewportSize(size);
  await page.route('**/__waha/pkg.json', (route) => route.fulfill({ contentType: 'application/json', body: readFileSync(path.join(dist, pkgFile!), 'utf8') }));
  await page.goto('/e2e/harness/waha.html' + (query ? '?' + query : ''));
  await expect(page.locator('.wa-root, [data-slot="plugin-state"]').first()).toBeVisible();
}
async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shots, `waha-ui-${name}.png`) });
}
const row = (page: Page, name: string | RegExp) => page.locator('.wa-row', { hasText: name });
const px = (page: Page, selector: string, prop: string) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

for (const theme of ['light', 'dark']) {
  const q = theme === 'dark' ? 'theme=dark' : '';
  const and = (extra: string) => [q, extra].filter(Boolean).join('&');

  test(`${theme}: chat list with unread and long names, empty right pane`, async ({ page }) => {
    await open(page, q);
    await expect(page.locator('.wa-row')).toHaveCount(11);
    await expect(row(page, 'Marina Costa').locator('.wa-pill')).toHaveText('2');
    await expect(row(page, '94444-3333').locator('.wa-pill')).toHaveText('99+');
    await expect(page.getByText('WhatsApp in Floq')).toBeVisible();
    // No raw WhatsApp ids anywhere.
    expect(await page.locator('.wa-root').innerText()).not.toMatch(/@(lid|c\.us|g\.us|s\.whatsapp\.net)/);
    // A long name is cut with an ellipsis instead of pushing the time out of the row.
    const long = row(page, 'Dra. Fernanda');
    const name = await long.locator('.wa-name').boundingBox(), time = await long.locator('.wa-time').boundingBox(), box = await long.boundingBox();
    expect(name!.x + name!.width).toBeLessThanOrEqual(time!.x);
    expect(time!.x + time!.width).toBeLessThanOrEqual(box!.x + box!.width);
    await shot(page, `${theme}-wide-list`);
  });

  test(`${theme}: open 1:1 chat`, async ({ page }) => {
    await open(page, q);
    await row(page, 'Marina Costa').click();
    await expect(page.locator('.wa-chat-head')).toContainText('Marina Costa');
    await expect(page.locator('.wa-chat-head')).toContainText('+55 11 98765-4321');
    await expect(page.locator('.wa-msg')).toHaveCount(10);
    await expect(row(page, 'Marina Costa').locator('.wa-pill')).toHaveCount(0);
    await expect(page.locator('.wa-day')).toHaveText(['Yesterday', 'Today']);
    // Bubbles stay inside ~65% of the column and never overlap each other.
    const col = await page.locator('.wa-col').boundingBox();
    const boxes = await page.locator('.wa-bubble').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width }; }));
    for (const b of boxes) expect(b.width).toBeLessThanOrEqual(col!.width * 0.66);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom);
    await shot(page, `${theme}-wide-chat`);
  });

  test(`${theme}: open group chat`, async ({ page }) => {
    await open(page, q);
    await row(page, 'Equipe Zoe').click();
    await expect(page.locator('.wa-chat-head')).toContainText('Equipe Zoe · Produção');
    await expect(page.locator('.wa-sender').first()).toHaveText('Rafael Souza');
    expect(await page.locator('.wa-chat-pane').innerText()).not.toMatch(/@(lid|c\.us|g\.us)/);
    await shot(page, `${theme}-wide-group`);
  });

  test(`${theme}: narrow panel shows one pane at a time`, async ({ page }) => {
    await open(page, q, { width: 600, height: 760 });
    await expect(page.locator('.wa-list-pane')).toBeVisible();
    await expect(page.locator('.wa-chat-pane')).toBeHidden();
    await shot(page, `${theme}-narrow-list`);
    await row(page, 'Marina Costa').click();
    await expect(page.locator('.wa-list-pane')).toBeHidden();
    await expect(page.locator('.wa-msg')).toHaveCount(10);
    await shot(page, `${theme}-narrow-chat`);
    await page.getByRole('button', { name: 'Back to chats' }).click();
    await expect(page.locator('.wa-list-pane')).toBeVisible();
    await row(page, 'Equipe Zoe').click();
    await expect(page.locator('.wa-sender').first()).toBeVisible();
    await shot(page, `${theme}-narrow-group`);
  });

  test(`${theme}: empty, loading and error states`, async ({ page }) => {
    await open(page, and('state=empty'));
    await expect(page.getByText('No messages yet')).toBeVisible();
    await shot(page, `${theme}-wide-empty`);
    await open(page, and('state=error'));
    await expect(page.getByText('Could not load chats')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await shot(page, `${theme}-wide-error`);
    await open(page, and('state=loading'));
    await expect(page.getByText('Loading chats…')).toBeVisible();
  });
}

test('installed context: the messenger layout comes from the plugin stylesheet, not from host utilities', async ({ page }) => {
  for (const query of ['', 'bare=1']) {
    await open(page, query);
    await row(page, 'Marina Costa').click();
    await expect(page.locator('.wa-msg')).toHaveCount(10);
    expect(await px(page, '.wa-row', 'height')).toBe('72px');
    expect(await px(page, '.wa-row .wa-avatar', 'width')).toBe('49px');
    expect(await px(page, '.wa-row .wa-avatar', 'border-radius')).toBe('50%');
    expect(await px(page, '.wa-mine .wa-bubble', 'background-color')).toBe('rgb(217, 253, 211)');
    expect(await px(page, '.wa-theirs .wa-bubble', 'background-color')).toBe('rgb(255, 255, 255)');
    expect(await px(page, '.wa-send', 'border-radius')).toBe('50%');
    expect(await px(page, '.wa-search input', 'border-radius')).toBe('999px');
    expect(await px(page, '.wa-panel', 'display')).toBe('grid');
    if (query) await shot(page, 'light-wide-chat-no-host-css');
  }
});

for (const theme of ['light', 'dark']) {
  test(`${theme}: reply to a message, quoted blocks and jump to the original`, async ({ page }) => {
    await open(page, theme === 'dark' ? 'theme=dark' : '');
    await row(page, 'Marina Costa').click();
    await expect(page.locator('.wa-msg')).toHaveCount(10);
    // Incoming and outgoing replies show who and what they quote.
    await expect(page.locator('.wa-quote')).toHaveCount(2);
    await expect(page.locator('.wa-theirs .wa-quote')).toContainText('You');
    await expect(page.locator('.wa-theirs .wa-quote')).toContainText('Te passo o orçamento em 10 min');
    await expect(page.locator('.wa-mine .wa-quote')).toContainText('Marina Costa');
    await expect(page.locator('.wa-mine .wa-quote')).toContainText('Photo or file');
    // Hover shows the Reply action; it is reachable from the keyboard too.
    const target = page.locator('.wa-msg', { hasText: 'Pode confirmar o endereço' });
    const act = target.getByRole('button', { name: 'Reply' });
    await expect(act).toHaveCSS('opacity', '0');
    await target.locator('.wa-bubble').hover();
    await expect(act).toHaveCSS('opacity', '1');
    if (shots) { mkdirSync(shots, { recursive: true }); await page.waitForTimeout(350); await page.screenshot({ path: path.join(shots, `waha-ui-${theme}-wide-reply-hover.png`) }); }
    await act.click();
    const bar = page.locator('.wa-replybar');
    await expect(bar).toContainText('Marina Costa');
    await expect(bar).toContainText('Pode confirmar o endereço de entrega? Rua das Laranjeiras, 120, apto 54');
    const field = page.getByRole('textbox', { name: 'Reply to Marina Costa' });
    await expect(field).toBeFocused();
    // Esc cancels; the cancel button does too.
    await page.keyboard.press('Escape');
    await expect(bar).toHaveCount(0);
    await act.focus();
    await page.keyboard.press('Enter');
    await expect(bar).toBeVisible();
    await page.getByRole('button', { name: 'Cancel reply' }).click();
    await expect(bar).toHaveCount(0);
    // Double click replies as well.
    await target.locator('.wa-bubble').dblclick();
    await expect(bar).toBeVisible();
    await field.fill('Confirmado, é esse mesmo.');
    await shot(page, `${theme}-wide-reply-compose`);
    await page.keyboard.press('Enter');
    const mine = page.locator('.wa-msg').last();
    await expect(mine).toContainText('Confirmado, é esse mesmo.');
    await expect(mine.locator('.wa-quote')).toContainText('Marina Costa');
    await expect(mine.locator('.wa-quote')).toContainText('Pode confirmar o endereço de entrega?');
    await expect(bar).toHaveCount(0);
    const sent = await page.evaluate(() => (window as unknown as { __calls: Array<{ path: string; body?: { text?: string; replyTo?: string } }> }).__calls.filter((c) => c.path === '/send').map((c) => c.body));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.replyTo).toBeTruthy();
    expect(await page.locator('.wa-chat-pane').innerText()).not.toMatch(/@(lid|c\.us|g\.us)/);
    await shot(page, `${theme}-wide-reply-sent`);
    // Clicking a quote scrolls to the original and highlights it briefly.
    await page.locator('.wa-log').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.locator('.wa-theirs .wa-quote').click();
    const original = page.locator('.wa-msg', { hasText: 'Te passo o orçamento em 10 min' }).first();
    await expect(original).toHaveClass(/wa-flash/);
    await expect(original).toBeInViewport();
    await expect(original).not.toHaveClass(/wa-flash/, { timeout: 4000 });
  });

  test(`${theme}: replies in a group and on a narrow panel`, async ({ page }) => {
    await open(page, theme === 'dark' ? 'theme=dark' : '');
    await row(page, 'Equipe Zoe').click();
    await expect(page.locator('.wa-quote')).toHaveCount(2);
    await expect(page.locator('.wa-mine .wa-quote')).toContainText('Bia Nogueira');
    // A quote whose original is not loaded shows what the reply carried and is not clickable.
    const stale = page.locator('.wa-theirs .wa-quote');
    await expect(stale).toContainText('+55 11 95555-6666');
    await expect(stale).toBeDisabled();
    await shot(page, `${theme}-wide-group-replies`);
    // Narrow: press and hold a bubble to reply.
    await open(page, theme === 'dark' ? 'theme=dark' : '', { width: 600, height: 760 });
    await row(page, 'Marina Costa').click();
    const bubble = page.locator('.wa-msg', { hasText: 'Combinado' }).locator('.wa-bubble');
    await bubble.dispatchEvent('pointerdown', { pointerType: 'touch', bubbles: true });
    await expect(page.locator('.wa-replybar')).toContainText('Combinado');
    await bubble.dispatchEvent('pointerup', { pointerType: 'touch', bubbles: true });
    await shot(page, `${theme}-narrow-reply-compose`);
    // No horizontal overflow from the reply bar or the quotes.
    expect(await page.locator('.wa-root').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.locator('.wa-log').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

test('search, filters, send and an incoming message', async ({ page }) => {
  await open(page);
  await page.getByRole('searchbox', { name: 'Search chats' }).fill('fernanda');
  await expect(page.locator('.wa-row')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search chats' }).fill('');
  await page.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect(page.locator('.wa-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await expect(page.locator('.wa-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await row(page, 'Marina Costa').click();
  const send = page.getByRole('button', { name: 'Send message' });
  await expect(send).toBeDisabled();
  await page.getByRole('textbox', { name: 'Message' }).fill('Confirmado, entrego na quinta!');
  await page.keyboard.press('Enter');
  await expect(page.locator('.wa-msg').last()).toContainText('Confirmado, entrego na quinta!');
  await expect(page.locator('.wa-msg')).toHaveCount(11);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  expect(await page.evaluate(() => (window as unknown as { __calls: Array<{ path: string; body?: { text?: string } }> }).__calls.filter((c) => c.path === '/send').map((c) => c.body?.text))).toEqual(['Confirmado, entrego na quinta!']);
  await page.evaluate(() => (window as unknown as { __incoming: (id: string, body: string) => void }).__incoming('193847561029384@lid', 'Podem me ligar?'));
  await expect(row(page, 'Podem me ligar?').locator('.wa-pill')).toHaveText('2');
});
