// Screenshots and behaviour of the full WhatsApp (WAHA) inbox, rendered from the built-in WhatsApp UI (src/plugins/whatsapp) through the installed-plugin path.
// WAHA_SHOTS=dir writes waha-full-*.png into that directory.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const shots = process.env.WAHA_SHOTS;
const WIDE = { width: 1280, height: 800 }, NARROW = { width: 390, height: 780 };

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8CAFQ0nCQCCmQ/h/mNylAAAAABJRU5ErkJggg==', 'base64');
type Call = { path: string; method: string; body: any };
const calls = (page: Page, p: string) => page.evaluate((x) => (window as unknown as { __calls: Call[] }).__calls.filter((c) => c.path.split('?')[0] === x), p);
const field = (page: Page) => page.locator('.wa-cfield textarea');
const bubble = (page: Page, text: string | RegExp) => page.locator('.wa-msg', { hasText: text }).last();
async function openChat(page: Page, query: string, name: string | RegExp, size = WIDE) {
  await open(page, query, size);
  await row(page, name).click();
  await expect(page.locator('.wa-composer')).toBeVisible();
  await expect(page.locator('.wa-msg').first()).toBeVisible();
}
async function menuOf(page: Page, text: string | RegExp) {
  const b = bubble(page, text);
  await b.scrollIntoViewIfNeeded();
  await b.locator('.wa-bubble').hover();
  await b.locator('.wa-chev').click();
  await expect(page.getByRole('menu')).toBeVisible();
  return page.getByRole('menu');
}

async function open(page: Page, query = '', size = WIDE) {
  await page.setViewportSize(size);
  await page.goto('/e2e/harness/waha.html' + (query ? '?' + query : ''));
  await expect(page.locator('.wa-root, [data-slot="plugin-state"]').first()).toBeVisible();
}
async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shots, `waha-full-${name}.png`) });
}
const row = (page: Page, name: string | RegExp) => page.locator('.wa-row', { hasText: name });

for (const theme of ['light', 'dark']) {
  test(`${theme}: QR login screen when WhatsApp is not linked`, async ({ page }) => {
    const q = [theme === 'dark' ? 'theme=dark' : '', 'state=qr'].filter(Boolean).join('&');
    // With chats already stored the inbox stays readable and a bar offers to link again.
    await open(page, q);
    await expect(page.locator('.wa-sbar')).toContainText('Phone not connected');
    await shot(page, `${theme}-wide-not-connected-bar`);
    await page.getByRole('button', { name: 'Link again' }).click();
    await expect(page.locator('.wa-gate')).toContainText(/Linked devices/i);
    await expect(page.getByRole('img', { name: /QR/i }).first()).toBeVisible();
    await shot(page, `${theme}-wide-qr-login`);
    await page.getByRole('button', { name: 'Back to chats' }).click();
    await expect(page.locator('.wa-row').first()).toBeVisible();
    await open(page, q, NARROW);
    await page.getByRole('button', { name: 'Link again' }).click();
    await expect(page.locator('.wa-gate')).toContainText(/Linked devices/i);
    await shot(page, `${theme}-narrow-qr-login`);
  });

  const q = theme === 'dark' ? 'theme=dark' : '';
  const and = (extra: string) => [q, extra].filter(Boolean).join('&');

  test(`${theme}: chat list: merged self chat, pictures, ticks, pinned, muted, archived`, async ({ page }) => {
    await open(page, q);
    await expect(row(page, 'Victor (You)')).toHaveCount(1);
    expect(await page.locator('.wa-root').innerText()).not.toMatch(/@(lid|c\.us|g\.us|s\.whatsapp\.net)/);
    await expect(page.locator('.wa-archived')).toContainText('2');
    await expect(row(page, 'Marina Costa').locator('.wa-avatar img')).toBeVisible();
    await shot(page, `${theme}-wide-list`);
    await row(page, 'Victor (You)').click();
    await expect(page.locator('.wa-chat-head')).toContainText('Victor (You)');
    await expect(page.locator('.wa-chat-head')).toContainText('Message yourself');
    await expect(page.locator('.wa-msg')).toHaveCount(6);
    await shot(page, `${theme}-wide-self-chat`);
  });

  test(`${theme}: conversation with every kind of message`, async ({ page }) => {
    await open(page, q);
    await row(page, 'Marina Costa').click();
    await expect(page.locator('.wa-chat-head')).toContainText('Marina Costa');
    await page.waitForTimeout(600);
    await shot(page, `${theme}-wide-chat-bottom`);
  });

  test(`${theme}: group info panel, contact panel, status and channels`, async ({ page }) => {
    await open(page, q);
    await row(page, 'Equipe Zoe').click();
    await page.locator('.wa-who-btn').click();
    await expect(page.locator('.wa-info')).toContainText('Rafael Souza');
    await shot(page, `${theme}-wide-group-info`);
    await row(page, 'Victor (You)').click();
    await page.locator('.wa-who-btn').click();
    await expect(page.locator('.wa-info')).toBeVisible();
    await shot(page, `${theme}-wide-self-info`);
    await page.getByRole('button', { name: 'Status', exact: true }).click();
    await expect(page.locator('.wa-overlay')).toContainText('Marina Costa');
    await shot(page, `${theme}-wide-status`);
  });

  test(`${theme}: composer: multiline text, send with ticks, a failed send comes back`, async ({ page }) => {
    await openChat(page, q, 'Marina Costa');
    await shot(page, `${theme}-wide-composer-empty`);
    await field(page).fill('Primeira linha\nSegunda linha\nTerceira linha, um pouco mais longa para quebrar');
    await expect(page.locator('.wa-action')).toHaveAttribute('data-mode', 'send');
    await shot(page, `${theme}-wide-composer-multiline`);
    await field(page).fill('Fechado, obrigado!');
    await field(page).press('Enter');
    await expect(bubble(page, 'Fechado, obrigado!')).toBeVisible();
    await expect(field(page)).toHaveValue('');
    expect((await calls(page, '/send')).at(-1)!.body).toEqual({ chatId: '5511987654321@c.us', text: 'Fechado, obrigado!' });
    // sent -> delivered -> read
    await expect(bubble(page, 'Fechado, obrigado!').getByLabel('Read')).toBeVisible({ timeout: 6000 });
    await shot(page, `${theme}-wide-ticks-read`);
    await field(page).fill('isto #fail');
    await field(page).press('Enter');
    await expect(page.getByText('Message not sent')).toBeVisible();
    // the text stays in the log as a bubble that says so and can be sent again; the field is free
    await expect(field(page)).toHaveValue('');
    await expect(bubble(page, 'isto #fail')).toHaveCount(1);
    await expect(bubble(page, 'isto #fail').getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test(`${theme}: attachments: pick, caption, upload as base64, image bubble`, async ({ page }) => {
    await openChat(page, q, 'Marina Costa');
    await page.locator('.wa-composer input[type=file]').first().setInputFiles([{ name: 'foto.png', mimeType: 'image/png', buffer: PNG }, { name: 'orcamento.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') }]);
    await expect(page.locator('.wa-tray')).toContainText('orcamento.pdf');
    await field(page).fill('Segue a foto e o orçamento');
    await shot(page, `${theme}-wide-composer-attachments`);
    await field(page).press('Enter');
    await expect.poll(async () => (await calls(page, '/send-media')).length).toBe(2);
    const sent = await calls(page, '/send-media');
    expect(sent[0].body).toMatchObject({ chatId: '5511987654321@c.us', kind: 'image', mime: 'image/png', filename: 'foto.png', caption: 'Segue a foto e o orçamento', data: PNG.toString('base64') });
    expect(sent[1].body).toMatchObject({ kind: 'document', filename: 'orcamento.pdf' });
    expect(sent[1].body.caption).toBeUndefined();
    await expect(bubble(page, 'Segue a foto e o orçamento').locator('img')).toBeVisible();
    await expect(bubble(page, 'orcamento.pdf')).toBeVisible();
    await shot(page, `${theme}-wide-sent-media`);
  });

  test(`${theme}: voice note: record, send, plays back`, async ({ page }) => {
    await openChat(page, q, 'Marina Costa');
    await page.locator('.wa-action').click();
    await expect(page.locator('.wa-composer')).toContainText(/0:0\d/);
    await page.waitForTimeout(1300);
    await shot(page, `${theme}-wide-composer-recording`);
    await page.getByRole('button', { name: /^Send voice message/ }).click();
    await expect.poll(async () => (await calls(page, '/send-media')).length).toBe(1);
    const v = (await calls(page, '/send-media'))[0].body;
    expect(v.kind).toBe('voice');
    expect(v.mime).toMatch(/^audio\//);
    expect(v.data.length).toBeGreaterThan(100);
    await expect(page.locator('.wa-msg[data-kind="ptt"]').last().getByRole('button', { name: /voice message/i }).first()).toBeVisible();
  });

  test(`${theme}: media bubbles: photo, voice note, document, location, contact, poll, link preview`, async ({ page }) => {
    await openChat(page, q, 'Marina Costa');
    const log = page.locator('.wa-log');
    const img = page.locator('.wa-msg[data-kind="image"]').first();
    await img.scrollIntoViewIfNeeded();
    await expect(img.locator('img')).toBeVisible();
    await expect(page.locator('.wa-msg[data-kind="ptt"]').first()).toBeVisible();
    await shot(page, `${theme}-wide-media-1-photo-voice-document`);
    await page.locator('.wa-msg[data-kind="location"]').first().scrollIntoViewIfNeeded();
    await log.evaluate((el) => { el.scrollTop += 120; });
    await expect(page.locator('.wa-msg[data-kind="vcard"]').first()).toContainText('Carla Transportes');
    await expect(page.locator('.wa-msg[data-kind="poll"]').first()).toContainText('Qual cor de caixa?');
    await shot(page, `${theme}-wide-media-2-location-contact-poll`);
    await bubble(page, 'Olha esse fornecedor').scrollIntoViewIfNeeded();
    await expect(bubble(page, 'Olha esse fornecedor')).toContainText('Caixas Kraft no atacado');
    await shot(page, `${theme}-wide-media-3-preview-sticker-video`);
    // a voice note plays through the plugin's media route
    const ptt = page.locator('.wa-msg[data-kind="ptt"]').first();
    await ptt.scrollIntoViewIfNeeded();
    await ptt.getByRole('button', { name: /^Play voice message/ }).click();
    await expect(ptt.getByRole('button', { name: /^Pause voice message/ })).toBeVisible({ timeout: 8000 });
    await shot(page, `${theme}-wide-media-4-voice-note-playing`);
    expect((await calls(page, '/media')).length).toBeGreaterThan(0);
    // the photo opens in the viewer
    await img.scrollIntoViewIfNeeded();
    await img.locator('.wa-img-btn').click();
    await expect(page.getByRole('dialog', { name: 'Photo viewer' }).locator('img')).toBeVisible();
    await shot(page, `${theme}-wide-lightbox`);
  });

  test(`${theme}: reactions, edit, star, delete for everyone, forward, message info`, async ({ page }) => {
    await openChat(page, q, 'Marina Costa');
    const target = bubble(page, 'Pode confirmar o endereço');
    await target.locator('.wa-bubble').hover();
    await target.getByRole('button', { name: 'React', exact: true }).click();
    await page.getByRole('button', { name: 'React 👍' }).click();
    await expect(target.locator('.wa-react-me')).toContainText('👍');
    expect((await calls(page, '/react')).at(-1)!.body).toMatchObject({ emoji: '👍' });
    // the chip of the last message is not cut off by the composer
    const chip = await target.locator('.wa-react-me').boundingBox(), bar = await page.locator('.wa-composer').boundingBox();
    expect(chip!.y + chip!.height).toBeLessThanOrEqual(bar!.y);
    await shot(page, `${theme}-wide-reactions`);
    // edit my own fresh message
    await field(page).fill('Entrega na quinta');
    await field(page).press('Enter');
    await expect(bubble(page, 'Entrega na quinta')).toBeVisible();
    await expect(bubble(page, 'Entrega na quinta')).not.toHaveClass(/wa-pending/);
    await expect(bubble(page, 'Entrega na quinta')).toHaveAttribute('data-mid', /^true_/);
    await (await menuOf(page, 'Entrega na quinta')).getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await expect(field(page)).toHaveValue('Entrega na quinta');
    await shot(page, `${theme}-wide-edit-bar`);
    await field(page).fill('Entrega na sexta');
    await field(page).press('Enter');
    await expect(bubble(page, 'Entrega na sexta')).toContainText('Edited');
    expect((await calls(page, '/edit')).at(-1)!.body.text).toBe('Entrega na sexta');
    // star
    await (await menuOf(page, 'Entrega na sexta')).getByRole('menuitem', { name: 'Star', exact: true }).click();
    expect((await calls(page, '/star')).at(-1)!.body.star).toBe(true);
    // menu screenshot, then forward
    const menu = await menuOf(page, 'Entrega na sexta');
    await shot(page, `${theme}-wide-message-menu`);
    await menu.getByRole('menuitem', { name: 'Forward', exact: true }).click();
    const fwd = page.getByRole('dialog');
    await fwd.getByRole('textbox', { name: 'Search chats' }).fill('lucas');
    await fwd.getByRole('option').first().getByRole('button').click();
    await shot(page, `${theme}-wide-forward-dialog`);
    await fwd.getByRole('button', { name: /^Forward/ }).click();
    await expect.poll(async () => (await calls(page, '/forward')).length).toBe(1);
    expect((await calls(page, '/forward'))[0].body.to).toEqual(['5541977776666@c.us']);
    // message info
    await (await menuOf(page, 'Entrega na sexta')).getByRole('menuitem', { name: 'Message info', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(/Read|Delivered|Sent/);
    await page.keyboard.press('Escape');
    // delete for everyone
    await (await menuOf(page, 'Entrega na sexta')).getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete for everyone' }).click();
    await expect(page.locator('.wa-msg[data-kind="deleted"]').last()).toContainText('You deleted this message');
    expect((await calls(page, '/delete')).at(-1)!.body.forEveryone).toBe(true);
  });

  test(`${theme}: poll, location and contact from the attach menu; search in the chat`, async ({ page }) => {
    await openChat(page, q, 'Marina Costa');
    await page.getByRole('button', { name: 'Attach', exact: true }).click();
    await shot(page, `${theme}-wide-attach-menu`);
    await page.getByRole('menuitem', { name: 'Poll' }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('textbox').nth(0).fill('Entrega em qual dia?');
    await d.getByRole('textbox').nth(1).fill('Quinta');
    await d.getByRole('textbox').nth(2).fill('Sexta');
    await shot(page, `${theme}-wide-poll-dialog`);
    await d.getByRole('button', { name: /^(Create|Send)/ }).click();
    await expect.poll(async () => (await calls(page, '/send-poll')).length).toBe(1);
    expect((await calls(page, '/send-poll'))[0].body).toMatchObject({ chatId: '5511987654321@c.us', name: 'Entrega em qual dia?', options: ['Quinta', 'Sexta'] });
    await expect(page.locator('.wa-msg[data-kind="poll"]').last()).toContainText('Entrega em qual dia?');
    // search
    await page.getByRole('button', { name: 'Search in this chat' }).click();
    await page.getByRole('textbox', { name: 'Search in this chat' }).fill('canecas');
    await expect(page.locator('.wa-sb-res button').first()).toBeVisible();
    await shot(page, `${theme}-wide-chat-search`);
  });

  test(`${theme}: chat menu: archive, mute, mark unread; archived list; new chat by number`, async ({ page }) => {
    await open(page, q);
    const r = page.locator('.wa-rowwrap', { hasText: 'James Whitfield' });
    await r.hover();
    await r.getByRole('button').last().click();
    await shot(page, `${theme}-wide-row-menu`);
    await page.getByRole('menuitem', { name: 'Archive chat' }).click();
    await expect.poll(async () => (await calls(page, '/chat/archive')).length).toBe(1);
    await expect(row(page, 'James Whitfield')).toHaveCount(0);
    await expect(page.locator('.wa-archived')).toContainText('3');
    await page.locator('.wa-archived').click();
    await expect(row(page, 'James Whitfield')).toBeVisible();
    await expect(row(page, 'Helena Prado')).toBeVisible();
    await shot(page, `${theme}-wide-archived`);
    await page.getByRole('button', { name: 'Back to chats' }).click();
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, `${theme}-wide-new-chat`);
  });

  test(`${theme}: a new message arrives; an incoming call shows a banner; typing shows in the header`, async ({ page }) => {
    await openChat(page, q, 'Marina Costa');
    await page.evaluate(() => (window as any).__incoming('5511987654321@c.us', 'Chegou agora 🎉', '5511987654321@c.us', 'Marina Costa'));
    await expect(bubble(page, 'Chegou agora 🎉')).toBeVisible();
    await page.evaluate(() => (window as any).__incoming('5541977776666@c.us', 'E aí?', '5541977776666@c.us', 'Lucas'));
    await expect(row(page, 'Lucas').locator('.wa-pill')).toHaveText('1');
    await page.evaluate(() => (window as any).__fake.presence('5511987654321@c.us', 'typing'));
    await expect(page.locator('.wa-chat-head')).toContainText(/typing/i);
    await page.evaluate(() => (window as any).__fake.call(false));
    await expect(page.getByText(/Incoming voice call/i)).toBeVisible();
    await shot(page, `${theme}-wide-incoming-call-typing`);
    await page.getByRole('button', { name: /Decline/ }).click();
    await expect.poll(async () => (await calls(page, '/call/reject')).length).toBe(1);
  });

  test(`${theme}: narrow panel: list, chat, composer, info overlay, nothing overflows`, async ({ page }) => {
    await open(page, q, NARROW);
    await expect(page.locator('.wa-chat-pane')).toBeHidden();
    await shot(page, `${theme}-narrow-list`);
    await row(page, 'Victor (You)').click();
    await expect(page.locator('.wa-list-pane')).toBeHidden();
    await expect(page.locator('.wa-msg')).toHaveCount(6);
    await shot(page, `${theme}-narrow-self-chat`);
    await page.getByRole('button', { name: 'Back to chats' }).click();
    await row(page, 'Marina Costa').click();
    await expect(page.locator('.wa-msg').first()).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, `${theme}-narrow-chat`);
    const over = await page.evaluate(() => { const r = document.querySelector('.wa-root')!; return [...r.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('.wa-log, .wa-chips, .wa-tray, [aria-hidden="true"]'); }).length; });
    expect(over).toBe(0);
    await field(page).fill('Uma mensagem longa o bastante para ocupar mais de uma linha no painel estreito');
    await shot(page, `${theme}-narrow-composer-typing`);
    await page.locator('.wa-who-btn').click();
    await expect(page.locator('.wa-info')).toBeVisible();
    await shot(page, `${theme}-narrow-contact-info`);
  });
}

test('an engine that cannot forward, star or pin hides those actions', async ({ page }) => {
  await openChat(page, 'engine=GOWS', 'Marina Costa');
  const menu = await menuOf(page, 'Pode confirmar o endereço');
  await expect(menu.getByRole('menuitem', { name: 'Reply' })).toBeVisible();
  for (const hidden of ['Forward', 'Star', 'Pin']) await expect(menu.getByRole('menuitem', { name: hidden, exact: true })).toHaveCount(0);
});

test('states: nothing yet, loading, WAHA down, not configured', async ({ page }) => {
  await open(page, 'state=empty');
  await expect(page.getByText('No messages yet')).toBeVisible();
  await open(page, 'state=loading');
  await expect(page.getByText('Loading chats…')).toBeVisible();
  await open(page, 'state=error');
  await expect(page.getByText('Could not load chats')).toBeVisible();
  await open(page, 'state=unconfigured');
  await expect(page.getByText('Connect WAHA')).toBeVisible();
});

test('installed context: the layout comes from the plugin stylesheet, not from host utilities', async ({ page }) => {
  await openChat(page, 'bare=1', 'Marina Costa');
  const list = await page.locator('.wa-list-pane').boundingBox(), chat = await page.locator('.wa-chat-pane').boundingBox();
  expect(list!.width).toBeGreaterThan(280);
  expect(chat!.x).toBeGreaterThanOrEqual(list!.x + list!.width - 1);
  const pill = await page.locator('.wa-cfield').boundingBox();
  expect(pill!.height).toBeGreaterThanOrEqual(40);
  expect(pill!.height).toBeLessThanOrEqual(46);
  await shot(page, 'light-wide-no-host-css');
});
