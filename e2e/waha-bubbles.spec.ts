// The WAHA plugin conversation log (bubbles, media, reactions, ticks, message menu, dialogs, lightbox), driven from the built-in WhatsApp UI (src/plugins/whatsapp)
// through its ?demo=bubbles view: light and dark, wide (1100x760) and narrow (380x760).
// WAHA_SHOTS=dir (default: the Artifacts folder)
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const shots = process.env.WAHA_SHOTS ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';

const WIDE = { width: 1100, height: 760 }, NARROW = { width: 380, height: 760 };

async function open(page: Page, theme: string, size = WIDE, extra = '') {
  await page.setViewportSize(size);
  await page.goto('/e2e/harness/waha-bubbles.html?demo=bubbles' + (theme === 'dark' ? '&theme=dark' : '') + extra);
  await expect(page.locator('.wa-msg').first()).toBeAttached({ timeout: 20_000 });
}
async function shot(page: Page, theme: string, name: string) {
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `waha-full-bubbles-${theme}-${name}.png`) });
}
const msg = (page: Page, kind: string, n = 0) => page.locator(`.wa-msg[data-kind="${kind}"]`).nth(n);
const scrollTo = async (page: Page, kind: string, n = 0) => { await msg(page, kind, n).scrollIntoViewIfNeeded(); await page.waitForTimeout(150); };

const calls = (page: Page, p: string) => page.evaluate((x) => (window as unknown as { __calls: Array<{ path: string; method: string; body: any }> }).__calls.filter((c) => c.path.startsWith(x)), p);
const hover = async (page: Page, kind: string, n = 0) => { await scrollTo(page, kind, n); await msg(page, kind, n).locator('.wa-bubble').hover(); };
const lastMine = (page: Page) => page.locator('.wa-msg', { hasText: 'Pode confirmar o endereço' });
const dialog = (page: Page) => page.getByRole('dialog');

for (const theme of ['light', 'dark']) {
  test.describe(theme, () => {
    test('wide overview: every bubble kind', async ({ page }) => {
      await open(page, theme);
      await page.waitForTimeout(500);
      const log = page.locator('.wa-log');
      const h = await log.evaluate((el) => el.scrollHeight - el.clientHeight);
      const steps = 8;
      for (let i = 0; i < steps; i++) {
        await log.evaluate((el, top) => { el.scrollTop = top; }, Math.round((h / (steps - 1)) * i));
        await page.waitForTimeout(700);
        await shot(page, theme, 'wide-scroll' + (i + 1));
      }
      // no horizontal overflow anywhere in the log
      expect(await log.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    });

    test('narrow overview at 380px: nothing overflows', async ({ page }) => {
      await open(page, theme, NARROW);
      await page.waitForTimeout(500);
      const log = page.locator('.wa-log');
      const h = await log.evaluate((el) => el.scrollHeight - el.clientHeight);
      const steps = 8;
      for (let i = 0; i < steps; i++) {
        await log.evaluate((el, top) => { el.scrollTop = top; }, Math.round((h / (steps - 1)) * i));
        await page.waitForTimeout(600);
        await shot(page, theme, 'narrow-scroll' + (i + 1));
      }
      expect(await log.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      const over = await page.evaluate(() => [...document.querySelectorAll('.wa-bubble')].filter((b) => b.getBoundingClientRect().right > window.innerWidth + 1).length);
      expect(over).toBe(0);
    });

    test('narrow: menu, dialogs and lightbox fit 380px', async ({ page }) => {
      await open(page, theme, NARROW);
      const last = lastMine(page);
      await last.scrollIntoViewIfNeeded();
      await last.locator('.wa-bubble').hover();
      await last.locator('.wa-chev').click();
      await expect(page.getByRole('menu')).toBeVisible();
      await shot(page, theme, 'narrow-menu');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Open forward dialog' }).click();
      await expect(dialog(page)).toBeVisible();
      await shot(page, theme, 'narrow-dialog-forward');
      expect(await dialog(page).evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth && el.getBoundingClientRect().left >= 0)).toBe(true);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Open poll dialog' }).click();
      await shot(page, theme, 'narrow-dialog-poll');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Open contact dialog' }).click();
      await expect(dialog(page).getByRole('option').first()).toBeVisible();
      await shot(page, theme, 'narrow-dialog-contact');
      await page.keyboard.press('Escape');
      await scrollTo(page, 'image', 0);
      await msg(page, 'image', 0).locator('.wa-img-btn').click();
      await expect(page.getByRole('dialog', { name: 'Photo viewer' })).toBeVisible();
      await page.waitForTimeout(400);
      await shot(page, theme, 'narrow-lightbox');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Search in chat' }).click();
      await page.getByRole('textbox', { name: 'Search in this chat' }).fill('estado');
      await expect(page.locator('.wa-sb-res button').first()).toBeVisible();
      await shot(page, theme, 'narrow-search');
    });

    test('group chat shows coloured sender names', async ({ page }) => {
      await open(page, theme, WIDE, '&chat=group');
      await page.waitForTimeout(400);
      await expect(page.locator('.wa-sender').first()).toBeVisible();
      await shot(page, theme, 'group-bottom');
      await page.locator('.wa-log').evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(500);
      await shot(page, theme, 'group-top');
    });

    test('message menu: chevron, items, reply and edit callbacks', async ({ page }) => {
      await open(page, theme);
      const last = lastMine(page);
      await last.scrollIntoViewIfNeeded();
      await last.locator('.wa-bubble').hover();
      await last.locator('.wa-chev').click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      for (const item of ['Reply', 'React', 'Forward', 'Star', 'Pin', 'Copy text', 'Edit', 'Message info', 'Delete']) await expect(menu.getByRole('menuitem', { name: item, exact: true })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Download' })).toHaveCount(0);
      await shot(page, theme, 'menu-open');
      await menu.getByRole('menuitem', { name: 'Star', exact: true }).click();
      await expect(last.locator('.wa-stamp .wa-st-ico')).toHaveCount(1);
      expect((await calls(page, '/star')).length).toBe(1);
      // keyboard: Escape closes
      await last.locator('.wa-bubble').hover();
      await last.locator('.wa-chev').click();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
    });

    test('image message offers Download, other people cannot be edited', async ({ page }) => {
      await open(page, theme);
      await hover(page, 'image', 0);
      await msg(page, 'image', 0).locator('.wa-chev').click();
      const menu = page.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: 'Download' })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Edit' })).toHaveCount(0);
      await shot(page, theme, 'menu-media');
      await page.keyboard.press('Escape');
    });

    test('reactions: quick bar, chip toggle, more emoji', async ({ page }) => {
      await open(page, theme);
      const last = lastMine(page);
      await last.scrollIntoViewIfNeeded();
      await last.locator('.wa-bubble').hover();
      await last.getByRole('button', { name: 'React', exact: true }).click();
      await expect(page.getByRole('toolbar', { name: 'Quick reactions' })).toBeVisible();
      await shot(page, theme, 'quick-reactions');
      await page.getByRole('button', { name: 'React 👍' }).click();
      await expect(last.locator('.wa-react-me')).toContainText('👍');
      await expect.poll(async () => (await calls(page, '/react')).at(-1)?.body.arg).toBe('👍');
      // click your chip again: removes it
      await last.locator('.wa-react-me').click();
      await expect(last.locator('.wa-react')).toHaveCount(0);
      await expect.poll(async () => (await calls(page, '/react')).at(-1)?.body.arg).toBe('');
      // the full picker
      await last.locator('.wa-bubble').hover();
      await last.getByRole('button', { name: 'React', exact: true }).click();
      await page.getByRole('button', { name: 'More emoji' }).click();
      await expect(page.locator('.wa-qpick .wa-emoji')).toBeVisible();
      await shot(page, theme, 'emoji-picker');
      await page.locator('.wa-qpick .wa-emoji-btn').first().click();
      await expect(last.locator('.wa-react-me')).toHaveCount(1);
      // existing reactions with counts
      const withCount = page.locator('.wa-msg', { hasText: 'Reações abaixo' }).locator('.wa-react', { hasText: '3' });
      await withCount.scrollIntoViewIfNeeded();
      await expect(withCount).toBeVisible();
      await shot(page, theme, 'reactions');
    });

    test('lightbox: open, zoom, arrows, Esc', async ({ page }) => {
      await open(page, theme);
      await scrollTo(page, 'image', 0);
      await msg(page, 'image', 0).locator('.wa-img-btn').click();
      const lb = page.getByRole('dialog', { name: 'Photo viewer' });
      await expect(lb).toBeVisible();
      await expect(lb.locator('img')).toBeVisible();
      await expect(lb.locator('.wa-lb-count')).toHaveText('1 of 3');
      await page.waitForTimeout(400);
      await shot(page, theme, 'lightbox');
      await lb.getByRole('button', { name: 'Zoom in' }).click();
      await lb.getByRole('button', { name: 'Zoom in' }).click();
      await shot(page, theme, 'lightbox-zoom');
      await page.keyboard.press('ArrowRight');
      await expect(lb.locator('.wa-lb-count')).toHaveText('2 of 3');
      await page.keyboard.press('Escape');
      await expect(lb).toHaveCount(0);
    });

    test('voice note plays, one at a time, speed cycles, seek', async ({ page }) => {
      await open(page, theme);
      await scrollTo(page, 'ptt', 0);
      const first = msg(page, 'ptt', 0), second = msg(page, 'ptt', 1);
      await first.getByRole('button', { name: /^Play voice message/ }).click();
      await expect(first.getByRole('button', { name: /^Pause voice message/ })).toBeVisible({ timeout: 8000 });
      await page.waitForTimeout(1400);
      await expect(first.locator('.fq-audio-time')).not.toHaveText('0:06');
      await expect(first.locator('.fq-audio-rate')).toBeVisible();
      await first.locator('.fq-audio-rate').click();
      await expect(first.locator('.fq-audio-rate')).toHaveText('1.5x');
      await shot(page, theme, 'voice-playing');
      await second.scrollIntoViewIfNeeded();
      await second.getByRole('button', { name: /^Play voice message/ }).click();
      await expect(second.getByRole('button', { name: /^Pause voice message/ })).toBeVisible({ timeout: 8000 });
      await expect(first.getByRole('button', { name: /^Play voice message/ })).toBeVisible();
      // seek with the keyboard
      await second.locator('.fq-audio-track').focus();
      await page.keyboard.press('ArrowRight');
      expect(Number(await second.locator('.fq-audio-track').getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(4);
    });

    test('voice note progress is smooth: it moves on (nearly) every frame and nothing in the message list re-renders', async ({ page }) => {
      await open(page, theme);
      await scrollTo(page, 'ptt', 0);
      const first = msg(page, 'ptt', 0);
      await first.getByRole('button', { name: /^Play voice message/ }).click();
      await expect(first.getByRole('button', { name: /^Pause voice message/ })).toBeVisible({ timeout: 8000 });
      await page.waitForTimeout(700); // the decoded waveform and the speed button are in: the player is at rest
      await first.evaluate((el) => {
        const w = window as any;
        const knob = el.querySelector('.fq-audio-knob') as HTMLElement, on = el.querySelector('.fq-audio-bars-on') as HTMLElement;
        w.__fqAudioRenders = 0; w.__frames = []; w.__mutations = [];
        // Everything that changes in the log while it plays. The player may touch the style of its two moving parts and the clock text; nothing else may change.
        const log = document.querySelector('.wa-log')!;
        w.__observer = new MutationObserver((list) => { for (const m of list) { const t = m.target instanceof Element ? m.target : m.target.parentElement!; w.__mutations.push({ type: m.type, attr: m.attributeName, cls: t.className, inPlayer: !!t.closest('.fq-audio') }); } });
        w.__observer.observe(log, { subtree: true, childList: true, attributes: true, characterData: true });
        const tick = () => { if (!w.__frames) return; w.__frames.push({ x: knob.getBoundingClientRect().left, clip: on.style.clipPath }); requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      await page.waitForTimeout(1500);
      const r = await page.evaluate(() => { const w = window as any; const frames = w.__frames as { x: number; clip: string }[]; w.__frames = null; w.__observer.disconnect(); return { frames, renders: w.__fqAudioRenders as number, mutations: w.__mutations as { type: string; attr: string | null; cls: string; inPlayer: boolean }[] }; });
      expect(r.frames.length).toBeGreaterThan(12); // a loaded CI machine draws fewer frames; what matters is that each one moves
      const moved = r.frames.slice(1).filter((f, i) => f.x > r.frames[i].x && f.clip !== r.frames[i].clip).length;
      expect(moved / (r.frames.length - 1)).toBeGreaterThan(0.9);
      expect(r.frames.at(-1)!.x).toBeGreaterThan(r.frames[0].x + 20);
      // no React render of any audio bubble or player, so none of the list
      expect(r.renders).toBe(0);
      expect(r.mutations.filter((m) => !m.inPlayer)).toEqual([]);
      const allowed = (m: { type: string; attr: string | null; cls: string }) => (m.type === 'attributes' && ((m.attr === 'style' && /fq-audio-(knob|bars-on)/.test(m.cls)) || (/^aria-value/.test(m.attr ?? '') && /fq-audio-track/.test(m.cls)))) || (m.type !== 'attributes' && /fq-audio-time/.test(m.cls));
      expect(r.mutations.filter((m) => !allowed(m))).toEqual([]);
      // paused: it stands still
      await first.getByRole('button', { name: /^Pause voice message/ }).click();
      await expect(first.getByRole('button', { name: /^Play voice message/ })).toBeVisible();
      const x1 = await first.locator('.fq-audio-knob').evaluate((e) => e.getBoundingClientRect().left);
      await page.waitForTimeout(400);
      expect(await first.locator('.fq-audio-knob').evaluate((e) => e.getBoundingClientRect().left)).toBe(x1);
      expect(x1).toBeGreaterThan(r.frames[0].x);
    });

    for (const [label, size] of [['wide', WIDE], ['narrow', NARROW], ['tiny', { width: 320, height: 760 }]] as const) {
      test(`voice note layout at ${label} width: the play button, the waveform and the knob share one centre line, paused and playing`, async ({ page }) => {
        await open(page, theme, size);
        const centre = (el: Element) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
        const check = async (kind: string, n: number) => {
          const m = msg(page, kind, n);
          const button = await m.locator('.fq-audio-play').evaluate(centre), wave = await m.locator('.fq-audio-track').evaluate(centre), knob = await m.locator('.fq-audio-knob').evaluate(centre);
          expect(Math.abs(button - wave), `${kind} ${n} button vs waveform`).toBeLessThanOrEqual(1);
          expect(Math.abs(button - knob), `${kind} ${n} button vs knob`).toBeLessThanOrEqual(1);
          // the time is under the waveform and starts where it starts
          const time = (await m.locator('.fq-audio-time').boundingBox())!, track = (await m.locator('.fq-audio-track').boundingBox())!;
          expect(time.y).toBeGreaterThanOrEqual(track.y + track.height - 0.5);
          expect(Math.abs(time.x - track.x)).toBeLessThanOrEqual(1);
          expect(track.width).toBeGreaterThan(60);
          // nothing of the player leaves its bubble
          const bubble = (await m.locator('.wa-bubble').boundingBox())!, player = (await m.locator('.wa-audio').boundingBox())!;
          expect(player.x + player.width).toBeLessThanOrEqual(bubble.x + bubble.width + 0.5);
        };
        await scrollTo(page, 'ptt', 0);
        // received voice note, own voice note, an audio file with its name
        await check('ptt', 0); await check('ptt', 1); await check('audio', 0);
        const first = msg(page, 'ptt', 0);
        await first.getByRole('button', { name: /^Play voice message/ }).click();
        await expect(first.getByRole('button', { name: /^Pause voice message/ })).toBeVisible({ timeout: 8000 });
        await page.waitForTimeout(900);
        await check('ptt', 0); // playing: the speed button is there now
        const rate = await first.locator('.fq-audio-rate').evaluate(centre), button = await first.locator('.fq-audio-play').evaluate(centre);
        expect(Math.abs(button - rate)).toBeLessThanOrEqual(1);
        if (label !== 'tiny') await shot(page, theme, 'voice-aligned-' + label);
        await first.getByRole('button', { name: /^Pause voice message/ }).click();
        await expect(first.getByRole('button', { name: /^Play voice message/ })).toBeVisible();
        await check('ptt', 0);
      });
    }

    test('unavailable media says so and can retry', async ({ page }) => {
      await open(page, theme);
      await scrollTo(page, 'image', 3);
      const gone = msg(page, 'image', 3);
      await expect(gone).toContainText('Not available here. Open WhatsApp on your phone to view it.');
      const before = (await calls(page, '/media')).length;
      await gone.getByRole('button', { name: 'Retry' }).click();
      await expect.poll(async () => (await calls(page, '/media')).length).toBeGreaterThan(before);
      await expect(gone).toContainText('Not available here');
    });

    test('poll: vote calls onAction, read-only on an engine without vote', async ({ page }) => {
      await open(page, theme);
      await scrollTo(page, 'poll', 0);
      const poll = msg(page, 'poll', 0);
      await poll.getByRole('radio', { name: /Verde/ }).click();
      await expect(poll.getByRole('radio', { name: /Verde/ })).toHaveAttribute('aria-checked', 'true');
      await expect.poll(async () => (await calls(page, '/vote')).at(-1)?.body.arg).toEqual(['Verde']);
      await page.goto('about:blank');
      await open(page, theme, WIDE, '&engine=NOWEB');
      await scrollTo(page, 'poll', 0);
      await expect(msg(page, 'poll', 0)).toContainText('Voting is not available');
      await expect(msg(page, 'poll', 0).getByRole('radio').first()).toBeDisabled();
    });

    test('engine without forward/star/pin hides those menu items', async ({ page }) => {
      await open(page, theme, WIDE, '&engine=GOWS');
      const last = lastMine(page);
      await last.scrollIntoViewIfNeeded();
      await last.locator('.wa-bubble').hover();
      await last.locator('.wa-chev').click();
      const menu = page.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: 'Reply' })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Forward' })).toHaveCount(0);
      await expect(menu.getByRole('menuitem', { name: 'Star' })).toHaveCount(0);
      await expect(menu.getByRole('menuitem', { name: 'Pin' })).toHaveCount(0);
    });

    test('delete dialog: for me and for everyone', async ({ page }) => {
      await open(page, theme);
      const last = lastMine(page);
      await last.scrollIntoViewIfNeeded();
      await last.locator('.wa-bubble').hover();
      await last.locator('.wa-chev').click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).getByRole('button', { name: 'Delete for me' })).toBeVisible();
      await shot(page, theme, 'dialog-delete');
      await dialog(page).getByRole('button', { name: 'Delete for everyone' }).click();
      await expect(dialog(page)).toHaveCount(0);
      expect((await calls(page, '/delete')).at(-1)!.body.arg).toEqual({ forEveryone: true });
      await expect(page.locator('.wa-msg[data-kind="deleted"]').last()).toContainText('You deleted this message');
    });

    test('forward dialog: search, pick up to 5', async ({ page }) => {
      await open(page, theme);
      await page.getByRole('button', { name: 'Open forward dialog' }).click();
      const d = dialog(page);
      await expect(d.getByRole('option')).toHaveCount(5);
      await d.getByRole('textbox', { name: 'Search chats' }).fill('lucas');
      await expect(d.getByRole('option')).toHaveCount(1);
      await d.getByRole('textbox', { name: 'Search chats' }).fill('');
      await d.getByRole('option').nth(0).getByRole('button').click();
      await d.getByRole('option').nth(2).getByRole('button').click();
      await expect(d).toContainText('2 of 5 selected');
      await shot(page, theme, 'dialog-forward');
      await d.getByRole('button', { name: 'Forward', exact: true }).click();
      await expect(d).toHaveCount(0);
      expect((await calls(page, '/forward')).at(-1)!.body.to).toHaveLength(2);
    });

    test('poll dialog: validation, add and remove options', async ({ page }) => {
      await open(page, theme);
      await page.getByRole('button', { name: 'Open poll dialog' }).click();
      const d = dialog(page);
      await d.getByRole('button', { name: 'Send poll' }).click();
      await expect(d.getByRole('alert')).toContainText('Type a question');
      await d.getByRole('textbox', { name: 'Question' }).fill('Qual horário?');
      await d.getByRole('textbox', { name: 'Option 1' }).fill('Manhã');
      await d.getByRole('button', { name: 'Send poll' }).click();
      await expect(d.getByRole('alert')).toContainText('at least two options');
      await d.getByRole('textbox', { name: 'Option 2' }).fill('manhã');
      await d.getByRole('button', { name: 'Send poll' }).click();
      await expect(d.getByRole('alert')).toContainText('must be different');
      await d.getByRole('textbox', { name: 'Option 2' }).fill('Tarde');
      await d.getByRole('button', { name: 'Add option' }).click();
      await d.getByRole('textbox', { name: 'Option 3' }).fill('Noite');
      for (let i = 0; i < 9; i++) await d.getByRole('button', { name: 'Add option' }).click();
      await expect(d.getByRole('button', { name: 'Add option' })).toBeDisabled();
      for (let i = 0; i < 9; i++) await d.getByRole('button', { name: /^Remove option/ }).last().click();
      await expect(d.getByRole('textbox', { name: /^Option/ })).toHaveCount(3);
      await d.getByRole('switch', { name: 'Allow multiple answers' }).click();
      await shot(page, theme, 'dialog-poll');
      await d.getByRole('button', { name: 'Send poll' }).click();
      await expect(d).toHaveCount(0);
      expect((await calls(page, '/send-poll')).at(-1)!.body).toEqual({ name: 'Qual horário?', options: ['Manhã', 'Tarde', 'Noite'], multiple: true });
    });

    test('location dialog: parses a pasted maps link', async ({ page }) => {
      await open(page, theme);
      await page.getByRole('button', { name: 'Open location dialog' }).click();
      const d = dialog(page);
      await expect(d.getByRole('button', { name: 'Send location' })).toBeDisabled();
      await d.getByRole('textbox', { name: /Paste a maps link/ }).fill('https://www.google.com/maps/@-23.5505,-46.6333,15z');
      await expect(d.getByRole('textbox', { name: 'Latitude' })).toHaveValue('-23.5505');
      await expect(d.getByRole('textbox', { name: 'Longitude' })).toHaveValue('-46.6333');
      await d.getByRole('textbox', { name: /Name/ }).fill('Ateliê');
      await shot(page, theme, 'dialog-location');
      await d.getByRole('button', { name: 'Send location' }).click();
      await expect.poll(async () => (await calls(page, '/send-location')).at(-1)?.body).toEqual({ latitude: -23.5505, longitude: -46.6333, title: 'Ateliê' });
    });

    test('contact dialog: search, and manual entry when the route is missing', async ({ page }) => {
      await open(page, theme);
      await page.getByRole('button', { name: 'Open contact dialog' }).click();
      const d = dialog(page);
      await expect(d.getByRole('option').first()).toBeVisible();
      await d.getByRole('option').first().getByRole('button').click();
      await shot(page, theme, 'dialog-contact');
      await d.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(async () => (await calls(page, '/send-contact')).at(-1)?.body.contacts).toHaveLength(1);
      await page.goto('about:blank');
      await open(page, theme, WIDE, '&contacts=0');
      await page.getByRole('button', { name: 'Open contact dialog' }).click();
      const m = dialog(page);
      await expect(m.getByRole('textbox', { name: 'Phone number' })).toBeVisible();
      await m.getByRole('textbox', { name: 'Name' }).fill('Ana');
      await m.getByRole('textbox', { name: 'Phone number' }).fill('123');
      await m.getByRole('button', { name: 'Add contact' }).click();
      await expect(m.getByRole('alert')).toContainText('international format');
      await m.getByRole('textbox', { name: 'Phone number' }).fill('+55 11 98765-4321');
      await m.getByRole('button', { name: 'Add contact' }).click();
      await expect(m).toContainText('1 selected');
      await shot(page, theme, 'dialog-contact-manual');
      await m.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(async () => (await calls(page, '/send-contact')).at(-1)?.body.contacts).toEqual([{ name: 'Ana', phone: '5511987654321' }]);
    });

    test('message info dialog', async ({ page }) => {
      await open(page, theme);
      await page.getByRole('button', { name: 'Open info dialog' }).click();
      const d = dialog(page);
      await expect(d).toContainText('Delivery');
      await expect(d).toContainText('Marina Costa');
      await shot(page, theme, 'dialog-info');
    });

    test('chat search lists matches and jumps, pinned bar jumps', async ({ page }) => {
      // the flash class lives 1.6s: record it instead of polling for it
      await page.addInitScript(() => {
        new MutationObserver((ms) => ms.forEach((m) => { if ((m.target as Element).classList?.contains('wa-flash')) (window as unknown as { __flash: number }).__flash = ((window as unknown as { __flash?: number }).__flash ?? 0) + 1; })).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
      });
      await open(page, theme);
      const flashes = () => page.evaluate(() => (window as unknown as { __flash?: number }).__flash ?? 0);
      await page.getByRole('button', { name: 'Search in chat' }).click();
      await page.getByRole('textbox', { name: 'Search in this chat' }).fill('estado');
      await expect(page.locator('.wa-sb-res button')).toHaveCount(6);
      await shot(page, theme, 'chat-search');
      await page.locator('.wa-log').evaluate((el) => { el.scrollTop = 0; });
      await page.locator('.wa-sb-res button').nth(2).click();
      await expect.poll(flashes).toBeGreaterThan(0);
      const afterSearch = await flashes();
      await page.getByRole('button', { name: 'Close search' }).click();
      await page.locator('.wa-log').evaluate((el) => { el.scrollTop = 0; });
      await page.getByRole('button', { name: /^Pinned message/ }).click();
      await expect.poll(flashes).toBeGreaterThan(afterSearch);
    });

    test('older messages: button and scroll to the top ask for more', async ({ page }) => {
      await open(page, theme, WIDE, '&hasmore=1');
      await page.locator('.wa-older').click();
      await expect(page.getByText('Load more', { exact: true })).toBeVisible();
      await expect(page.locator('.wa-older')).toBeVisible();
    });

    test('text formatting and links render without markup injection', async ({ page }) => {
      await open(page, theme);
      const t = msg(page, 'text', 0);
      await expect(t.locator('strong')).toHaveText('Chegaram');
      await expect(t.locator('em')).toHaveText('canecas');
      await expect(t.locator('s')).toHaveText('antigas');
      await expect(t.locator('code.wa-code')).toHaveText('código 42');
      const a = t.locator('a');
      await expect(a).toHaveAttribute('href', 'https://example.com/pedido/a_b_c_2231');
      await expect(a).toHaveAttribute('target', '_blank');
      await expect(a).toHaveAttribute('rel', 'noreferrer noopener');
      await expect(page.locator('.wa-at').first()).toContainText('@Bia Nogueira');
      await expect(page.locator('.wa-emoji-big')).toHaveCount(1);
    });
  });
}
