// Polish of the built-in WhatsApp inbox (src/plugins/whatsapp): label tags on chat rows, the row menu button's fade, the refresh icon's turn,
// menus that stay anchored to their button on every open (a hidden trigger used to send its menu to the window's top-left corner),
// typing that renders nothing but the composer, and a sent message that is one bubble from the clock to the ticks.
// WAHA_SHOTS=dir  (default: the Artifacts folder)
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

const shots = process.env.WAHA_SHOTS ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
const WIDE = { width: 1280, height: 800 };

async function open(page: Page, theme: string, extra = '') {
  await page.setViewportSize(WIDE);
  await page.goto('/e2e/harness/waha.html?' + [theme === 'dark' ? 'theme=dark' : '', extra].filter(Boolean).join('&'));
  await expect(page.locator('.wa-row').first()).toBeVisible();
}
async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) {
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, 'waha-polish-' + name + '.png'), clip });
}
const LIST = { x: 0, y: 0, width: 440, height: 520 };

/** What is painted: every background from <html> down to the element, composited on a canvas, and the text colour on top of that. */
const painted = (el: Locator) => el.evaluate((node) => {
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const px = () => Array.from(g.getImageData(0, 0, 1, 1).data);
  const chain: Element[] = []; for (let e: Element | null = node; e; e = e.parentElement) chain.unshift(e);
  g.fillStyle = '#fff'; g.fillRect(0, 0, 1, 1);
  for (const e of chain) { g.fillStyle = getComputedStyle(e).backgroundColor; g.fillRect(0, 0, 1, 1); }
  const bg = px();
  g.fillStyle = getComputedStyle(node).color; g.fillRect(0, 0, 1, 1);
  const fg = px();
  const own = document.createElement('canvas'); own.width = own.height = 1;
  const o = own.getContext('2d')!; o.fillStyle = getComputedStyle(node).backgroundColor; o.fillRect(0, 0, 1, 1);
  return { bg, fg, ownAlpha: o.getImageData(0, 0, 1, 1).data[3] / 255 };
});
const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a: number[], b: number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

/** Records where every open menu is, on each frame and on each DOM change, from now on. */
const watchMenus = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __menus: Array<{ x: number; y: number; w: number; h: number; state: string | null }> };
  w.__menus = [];
  const sample = () => { for (const m of document.querySelectorAll('[role="menu"]')) { const r = m.getBoundingClientRect(); if (r.width > 0) w.__menus.push({ x: r.x, y: r.y, w: r.width, h: r.height, state: m.getAttribute('data-state') }); } };
  new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-state'] });
  const tick = () => { sample(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const menuSamples = (page: Page) => page.evaluate(() => (window as unknown as { __menus: Array<{ x: number; y: number; w: number; h: number; state: string | null }> }).__menus);
/** No frame had a menu in the window's top-left corner (where a menu with no anchor box lands). */
async function neverInCorner(page: Page) {
  const all = await menuSamples(page);
  expect(all.length).toBeGreaterThan(5);
  expect(all.filter((s) => s.x < 60 && s.y < 60 && s.y + s.h > 0)).toEqual([]);
}
/** The open menu touches its button: just below or above it, sharing its horizontal span. */
async function anchored(page: Page, trigger: Locator) {
  const menu = page.getByRole('menu').first();
  await expect(menu).toBeVisible();
  await expect.poll(async () => (await menu.evaluate((m) => getComputedStyle(m).opacity))).toBe('1');
  const [m, b] = [(await menu.boundingBox())!, (await trigger.boundingBox())!];
  expect(b.width).toBeGreaterThan(0);
  expect(m.x, 'not at the window corner').toBeGreaterThan(60);
  const gap = Math.min(Math.abs(m.y - (b.y + b.height)), Math.abs(b.y - (m.y + m.height)));
  expect(gap, 'vertical gap between button and menu').toBeLessThanOrEqual(12);
  expect(m.x, 'menu starts before the button ends').toBeLessThanOrEqual(b.x + b.width);
  expect(m.x + m.width, 'menu ends after the button starts').toBeGreaterThanOrEqual(b.x);
  return m;
}
/** Open, Escape, open, click away, open again quickly: the menu is at its button every time. */
async function cycle(page: Page, trigger: Locator, before: () => Promise<unknown> = async () => undefined) {
  const boxes = [];
  for (const close of ['escape', 'outside', 'quick', 'escape'] as const) {
    await before();
    await trigger.click();
    boxes.push(await anchored(page, trigger));
    if (close === 'escape') await page.keyboard.press('Escape'); else await page.mouse.click(900, 700);
    if (close === 'quick') await page.waitForTimeout(40); // reopen while the menu is still fading out
    else await expect(page.getByRole('menu')).toHaveCount(0);
  }
  for (const b of boxes) { expect(Math.abs(b.x - boxes[0].x)).toBeLessThanOrEqual(1); expect(Math.abs(b.y - boxes[0].y)).toBeLessThanOrEqual(1); }
  await expect(page.getByRole('menu')).toHaveCount(0);
}

for (const theme of ['dark', 'light']) {
  test.describe(theme, () => {
    test('label tag on a chat row: label colour as a dot and a faint tint, readable text, lined up with the unread badge', async ({ page }) => {
      await open(page, theme);
      const wrap = page.locator('.wa-rowwrap', { hasText: 'Marina Costa' });
      const chip = wrap.locator('.wa-lchip');
      await expect(chip).toHaveText('Cliente novo');
      const p = await painted(chip);
      expect(contrast(p.fg, p.bg), 'text on the tag').toBeGreaterThanOrEqual(7);
      expect(p.ownAlpha, 'a tint, not a filled pill').toBeLessThan(0.3);
      expect(p.ownAlpha).toBeGreaterThan(0.05);
      // the text is the theme's own colour, the label colour is the dot
      expect(await chip.evaluate((e) => getComputedStyle(e).color === getComputedStyle(e.closest('.wa-root')!).color)).toBe(true);
      expect(await chip.locator('i').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(100, 196, 255)');
      const dot = await painted(chip.locator('i'));
      expect(contrast([100, 196, 255], dot.bg.slice(0, 3) as number[]) > 1.5 || contrast([100, 196, 255], p.bg) > 1.5).toBe(true);
      const [c, pill, line] = await Promise.all([chip.boundingBox(), wrap.locator('.wa-pill').boundingBox(), wrap.locator('.wa-line').last().boundingBox()]);
      expect(c!.height).toBe(pill!.height);
      expect(Math.abs(c!.y - pill!.y)).toBeLessThanOrEqual(0.5);
      expect(c!.x + c!.width).toBeLessThanOrEqual(pill!.x);
      expect(c!.x + c!.width).toBeLessThanOrEqual(line!.x + line!.width + 0.5);
      expect(await chip.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      await page.mouse.move(900, 700);
      await shot(page, theme + '-label-tag', LIST);
    });

    test('row menu button fades in on hover and keeps its place in the layout', async ({ page }) => {
      await open(page, theme);
      const wrap = page.locator('.wa-rowwrap', { hasText: 'Marina Costa' });
      const holder = wrap.locator('.wa-rowmenu'), btn = holder.getByRole('button');
      await page.mouse.move(900, 700);
      const css = await holder.evaluate((e) => { const s = getComputedStyle(e); return { opacity: s.opacity, display: s.display, prop: s.transitionProperty, dur: s.transitionDuration, ease: s.transitionTimingFunction, pe: s.pointerEvents }; });
      expect(css.opacity).toBe('0');
      expect(css.display).not.toBe('none');
      expect(css.pe).toBe('none');
      expect(css.prop).toContain('opacity');
      expect(css.prop).toContain('transform');
      expect(css.dur).toContain('0.15s');
      expect(css.ease).toContain('ease-out');
      expect((await btn.boundingBox())!.width).toBe(28); // has a box while hidden: a menu can always be placed against it
      // sample the fade: it passes through values between 0 and 1
      await holder.evaluate((e) => { const w = window as unknown as { __fade: number[] }; w.__fade = []; const t = () => { w.__fade.push(Number(getComputedStyle(e).opacity)); if (w.__fade.length < 40) requestAnimationFrame(t); }; requestAnimationFrame(t); });
      await wrap.hover();
      await expect.poll(() => holder.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
      const fade = await page.evaluate(() => (window as unknown as { __fade: number[] }).__fade);
      expect(fade.some((v) => v > 0 && v < 1), 'opacity went through intermediate values: ' + fade.join(',')).toBe(true);
      // it takes room from the preview and never covers the tag or the badge
      const m = (await holder.boundingBox())!;
      for (const sel of ['.wa-preview', '.wa-lchip', '.wa-pill']) { const b = (await wrap.locator('.wa-line').last().locator(sel).boundingBox())!; expect(b.x + b.width, sel).toBeLessThanOrEqual(m.x + 0.5); }
      await expect(wrap.locator('.wa-pill')).toBeVisible();
      await shot(page, theme + '-row-hover', LIST);
      // keyboard: the button is reachable and shows when focused
      await page.mouse.move(900, 700);
      await expect.poll(() => holder.evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
      await btn.focus();
      await expect.poll(() => holder.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    });

    test('row menu opens at its button: first open, after Escape, after a click away, and while the last one is still closing', async ({ page }) => {
      await open(page, theme);
      await watchMenus(page);
      const wrap = page.locator('.wa-rowwrap', { hasText: 'Unknown contact' });
      const holder = wrap.locator('.wa-rowmenu'), btn = holder.locator('button'); // by tag: an open menu hides the rest of the page from roles
      await cycle(page, btn, () => wrap.hover());
      await neverInCorner(page);
      // while the menu is open the row keeps its button, wherever the pointer is
      await wrap.hover();
      await btn.click();
      await anchored(page, btn);
      await page.mouse.move(900, 700);
      await page.waitForTimeout(250);
      expect(await holder.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
      await anchored(page, btn);
      await shot(page, theme + '-row-menu');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await neverInCorner(page);
    });
  });
}

test('the other menus of the inbox stay at their button too: chat header, account, label filter, message', async ({ page }) => {
  await open(page, 'dark');
  await page.locator('.wa-row', { hasText: 'Marina Costa' }).click();
  await expect(page.locator('.wa-msg').first()).toBeVisible();
  await watchMenus(page);
  await cycle(page, page.locator('.wa-chat-head button[aria-label^="Menu of"]'));
  await cycle(page, page.locator('.wa-list-pane .wa-head [aria-haspopup="menu"]').first());
  await cycle(page, page.locator('.wa-lfilter'));
  const msg = page.locator('.wa-msg').last();
  await cycle(page, msg.locator('.wa-chev'), () => msg.locator('.wa-bubble').hover());
  await neverInCorner(page);
});

test.describe('refresh icon', () => {
  /** Makes the chat list take ms to load. */
  const slow = (page: Page, ms: number) => page.evaluate((d) => {
    const fake = (window as unknown as { __fake: { fetch: (p: string, i?: unknown) => Promise<unknown> } }).__fake, real = fake.fetch;
    fake.fetch = async (p, i) => { if (p.split('?')[0] === '/chats') await new Promise((r) => setTimeout(r, d)); return real(p, i); };
  }, ms);
  const angles = (page: Page) => page.evaluate(() => (window as unknown as { __angles: number[] }).__angles);

  test('turns at a constant speed while the refresh is pending and stops at the end of a turn', async ({ page }) => {
    await open(page, 'dark');
    const btn = page.getByRole('button', { name: 'Refresh chats' }), svg = btn.locator('svg');
    await expect(btn).not.toHaveAttribute('data-spin', '', { timeout: 5000 }); // the first load's turn is over
    expect(await svg.evaluate((e) => e.getAnimations().filter((a) => 'animationName' in a).length)).toBe(0);
    const style = await svg.evaluate((e) => { const s = getComputedStyle(e); return { origin: s.transformOrigin, will: s.willChange }; });
    expect(style.will).toBe('transform');
    expect(style.origin).toBe('11px 11px'); // the centre of the 22px icon
    await slow(page, 1300);
    await svg.evaluate((e) => {
      const w = window as unknown as { __angles: number[]; __icon: Element }; w.__angles = []; w.__icon = e;
      const t = () => { const m = new DOMMatrix(getComputedStyle(e).transform); w.__angles.push(Math.round(((Math.atan2(m.b, m.a) * 180) / Math.PI + 360) % 360) % 360); requestAnimationFrame(t); };
      requestAnimationFrame(t);
    });
    await btn.click();
    await expect(btn).toHaveAttribute('data-spin', '');
    await expect(btn).toHaveAttribute('aria-busy', 'true');
    const anim = await svg.evaluate((e) => e.getAnimations().filter((a) => 'animationName' in a).map((a) => ({ name: (a as CSSAnimation).animationName, state: a.playState, timing: a.effect!.getComputedTiming() })));
    expect(anim).toHaveLength(1);
    expect(anim[0].name).toBe('wa-rot');
    expect(anim[0].state).toBe('running');
    expect(anim[0].timing.easing).toBe('linear');
    expect(anim[0].timing.iterations).toBe(Infinity);
    expect(anim[0].timing.duration).toBe(900);
    await page.waitForTimeout(600);
    await shot(page, 'refresh-spinning', { x: 0, y: 0, width: 440, height: 120 });
    // one animation from the click to the end: same node, same animation, started once
    const started = await svg.evaluate((e) => e.getAnimations().filter((a) => 'animationName' in a)[0].startTime);
    await page.waitForTimeout(500);
    expect(await svg.evaluate((e) => e.getAnimations().filter((a) => 'animationName' in a)[0]?.startTime)).toBe(started);
    await expect(btn).not.toHaveAttribute('data-spin', '', { timeout: 5000 });
    await expect(btn).not.toHaveAttribute('aria-busy', 'true');
    expect(await svg.evaluate((e) => e === (window as unknown as { __icon: Element }).__icon)).toBe(true);
    expect(await svg.evaluate((e) => e.getAnimations().filter((a) => 'animationName' in a).length)).toBe(0);
    // it only ever turned forwards, in small steps, and stopped at the top of a turn (not cut mid-way)
    const a = (await angles(page)).filter((v, i, all) => i === 0 || v !== all[i - 1]);
    const moving = a.slice(a.findIndex((v) => v > 0));
    expect(moving.length).toBeGreaterThan(20);
    let turns = 0;
    for (let i = 1; i < moving.length; i++) {
      const d = (moving[i] - moving[i - 1] + 360) % 360;
      if (moving[i] < moving[i - 1]) turns++;
      expect(d, 'step ' + i + ' of ' + moving.join(',')).toBeLessThan(120);
    }
    expect(turns).toBeGreaterThanOrEqual(2); // 1.3 s of loading: the second turn is finished, then it stops
    expect(moving[moving.length - 1]).toBe(0);
    expect(Math.max(...moving.slice(-4, -1))).toBeGreaterThan(270);
  });

  test('a refresh that ends at once still makes one whole turn after a click', async ({ page }) => {
    await open(page, 'dark');
    const btn = page.getByRole('button', { name: 'Refresh chats' }), svg = btn.locator('svg');
    await expect(btn).not.toHaveAttribute('data-spin', '', { timeout: 5000 });
    expect(await svg.evaluate((e) => e.getAnimations().filter((a) => 'animationName' in a).length)).toBe(0);
    await btn.click();
    await page.waitForTimeout(300);
    expect(await svg.evaluate((e) => e.getAnimations().filter((a) => 'animationName' in a).length)).toBe(1);
    await expect(btn).not.toHaveAttribute('data-spin', '', { timeout: 3000 });
  });

  test('reduced motion: no turn, the icon takes the accent colour while pending', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'dark');
    const btn = page.getByRole('button', { name: 'Refresh chats' }), svg = btn.locator('svg');
    await page.waitForTimeout(400);
    const idle = await svg.evaluate((e) => getComputedStyle(e).color);
    await slow(page, 900);
    await btn.click();
    await expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(await svg.evaluate((e) => e.getAnimations().filter((a) => 'animationName' in a).length)).toBe(0);
    expect(await svg.evaluate((e) => getComputedStyle(e).transform)).toBe('none');
    await expect.poll(() => svg.evaluate((e) => getComputedStyle(e).color)).not.toBe(idle);
    await expect(btn).not.toHaveAttribute('aria-busy', 'true', { timeout: 4000 });
    await expect.poll(() => svg.evaluate((e) => getComputedStyle(e).color)).toBe(idle);
    // and the row menu button shows without a transition
    expect(await page.locator('.wa-rowmenu').first().evaluate((e) => Number.parseFloat(getComputedStyle(e).transitionDuration))).toBeLessThan(0.001);
  });
});

// ---- composer: typing ----
const field = (page: Page) => page.locator('.wa-cfield textarea');
const bubble = (page: Page, text: string) => page.locator('.wa-msg', { hasText: text });
type Call = { path: string; method: string; body: any };
const calls = (page: Page, p: string) => page.evaluate((x) => (window as unknown as { __calls: Call[] }).__calls.filter((c) => c.path.split('?')[0] === x), p);
async function openChat(page: Page, theme = 'dark', name = 'Marina Costa', extra = '') {
  await open(page, theme, extra);
  await page.locator('.wa-row', { hasText: name }).click();
  await expect(page.locator('.wa-msg').first()).toBeVisible();
  await expect(field(page)).toBeFocused();
}
const renders = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __waRenders: Record<string, number> }).__waRenders }));

test.describe('typing in the composer', () => {
  test('renders the composer only: not the message list, its rows, the conversation or the chat list', async ({ page }) => {
    await openChat(page);
    await page.waitForTimeout(600); // presence, avatars and the first reads have settled
    const rows = await page.locator('.wa-msg').count();
    expect(rows).toBeGreaterThan(5);
    await page.evaluate(() => {
      const w = window as unknown as { __waRenders: Record<string, number>; __logMutations: number };
      w.__waRenders = {}; w.__logMutations = 0;
      new MutationObserver((l) => { w.__logMutations += l.length; }).observe(document.querySelector('.wa-log')!, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const text = 'Bom dia! Segue o orçamento atualizado, qualquer dúvida me avise.';
    await field(page).pressSequentially(text, { delay: 12 });
    await expect(field(page)).toHaveValue(text);
    const r = await renders(page);
    expect(r.composer, 'the composer itself follows the keys').toBeGreaterThanOrEqual(text.length);
    expect(r.log ?? 0, 'message list renders').toBe(0);
    expect(r.row ?? 0, 'message row renders').toBe(0);
    expect(r.conversation ?? 0, 'conversation renders').toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __logMutations: number }).__logMutations), 'DOM changes in the log').toBe(0);
    // the typing signal goes out once for the burst, not per key
    expect((await calls(page, '/typing')).filter((c) => c.body.state === 'composing')).toHaveLength(1);
    // send button follows the text, and the draft belongs to its chat
    await expect(page.locator('.wa-action')).toHaveAttribute('data-mode', 'send');
    await page.locator('.wa-row', { hasText: 'Equipe Zoe' }).click();
    await expect(field(page)).toHaveValue('');
    await field(page).fill('para o grupo');
    await page.locator('.wa-row', { hasText: 'Marina Costa' }).click();
    await expect(field(page)).toHaveValue(text);
    await page.locator('.wa-row', { hasText: 'Equipe Zoe' }).click();
    await expect(field(page)).toHaveValue('para o grupo');
  });

  test('a key is handled within a frame, and the field still grows and shrinks with its lines', async ({ page }) => {
    await openChat(page);
    await page.waitForTimeout(600);
    // the work one key causes, measured where it happens: React handles the input event before dispatchEvent returns, then the layout it left is flushed
    const cost = await field(page).evaluate((el) => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      const times: number[] = [];
      let v = '';
      for (const ch of 'Uma mensagem digitada tecla por tecla, sem travar.') {
        v += ch;
        const t0 = performance.now();
        set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        void document.body.offsetHeight;
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      return { median: times[Math.floor(times.length / 2)], max: times[times.length - 1], n: times.length };
    });
    console.log('key cost (ms)', JSON.stringify(cost));
    expect(cost.median, 'median ms per key').toBeLessThan(8);
    expect(cost.max, 'slowest key in ms').toBeLessThan(50);
    // Real keys, from the key to the next painted frame (Event Timing). On the solid material: this browser has no GPU, and there the acrylic blur
    // behind the whole view takes over 100 ms to paint per frame whatever changed (the search field too), which would hide what is measured here.
    await openChat(page, 'dark', 'Marina Costa', 'material=solid');
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const w = window as unknown as { __keys: number[] }; w.__keys = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'input') w.__keys.push(e.duration); }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
    });
    await field(page).pressSequentially('Digitando de verdade, com o teclado, numa conversa cheia.', { delay: 25 });
    await page.waitForTimeout(300);
    const keys = (await page.evaluate(() => (window as unknown as { __keys: number[] }).__keys)).sort((a, b) => a - b);
    console.log('key to paint (ms)', JSON.stringify({ n: keys.length, median: keys[Math.floor(keys.length / 2)] ?? 0, max: keys[keys.length - 1] ?? 0 }));
    expect(keys[Math.floor(keys.length / 2)] ?? 0, 'median key-to-paint in ms').toBeLessThanOrEqual(50);
    expect(keys[keys.length - 1] ?? 0, 'slowest key-to-paint in ms').toBeLessThan(100);
    await field(page).fill('');
    // auto-grow kept working without resetting the height on every key
    const h1 = (await field(page).boundingBox())!.height;
    await field(page).press('Shift+Enter');
    await field(page).pressSequentially('segunda linha');
    const h2 = (await field(page).boundingBox())!.height;
    expect(h2).toBeGreaterThan(h1 + 10);
    await field(page).fill('curta');
    expect(Math.abs((await field(page).boundingBox())!.height - h1)).toBeLessThanOrEqual(1);
  });
});

// ---- sending ----
test.describe('sending a message', () => {
  /** Slows /send down; mode "late" answers after the stored copy has already reached the log (the webhook wins the race); "fail-once" refuses the first one. */
  const tune = (page: Page, mode: 'slow' | 'late' | 'fail-once') => page.evaluate((m) => {
    const fake = (window as unknown as { __fake: { fetch: (p: string, i?: unknown) => Promise<unknown> } }).__fake, real = fake.fetch;
    let n = 0;
    const w = window as unknown as { __sendTries: unknown[] }; w.__sendTries = [];
    fake.fetch = async (p, i) => {
      if (p.split('?')[0] !== '/send') return real(p, i);
      w.__sendTries.push((i as { body?: unknown } | undefined)?.body);
      if (m === 'fail-once' && n++ === 0) { await new Promise((r) => setTimeout(r, 300)); throw Object.assign(new Error('WAHA could not do that.'), { status: 502, code: 'waha_unavailable' }); }
      if (m === 'slow') await new Promise((r) => setTimeout(r, 700));
      const res = await real(p, i);
      if (m === 'late') await new Promise((r) => setTimeout(r, 1100)); // the fake's "delivered" event (700 ms) makes the inbox read the log first
      return res;
    };
  }, mode);
  /** Follows one bubble from the moment it appears: its node, how many bubbles carry its text, rows added or removed, animations started. */
  const follow = (page: Page, text: string) => page.evaluate((t) => {
    const w = window as unknown as { __send: { node: Element | null; maxCopies: number; added: number; removed: number; anims: string[]; opacity: number[] } };
    const s = (w.__send = { node: null as Element | null, maxCopies: 0, added: 0, removed: 0, anims: [] as string[], opacity: [] as number[] });
    const col = document.querySelector('.wa-col')!;
    const mine = () => [...col.querySelectorAll('.wa-msg')].filter((n) => n.textContent!.includes(t));
    const look = () => {
      const all = mine();
      s.maxCopies = Math.max(s.maxCopies, all.length);
      if (!s.node && all[0]) { s.node = all[0]; all[0].addEventListener('animationstart', (e) => s.anims.push((e as AnimationEvent).animationName)); }
      if (s.node) s.opacity.push(Number(getComputedStyle(s.node.querySelector('.wa-bubble')!).opacity));
    };
    new MutationObserver((list) => {
      for (const m of list) {
        for (const n of m.addedNodes) if (n instanceof Element && n.matches('.wa-msg')) s.added++;
        for (const n of m.removedNodes) if (n instanceof Element && n.matches('.wa-msg')) s.removed++;
      }
      look();
    }).observe(col, { childList: true, subtree: true, attributes: true });
    const tick = () => { look(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, text);
  const followed = (page: Page) => page.evaluate(() => { const s = (window as unknown as { __send: { node: Element | null; maxCopies: number; added: number; removed: number; anims: string[]; opacity: number[] } }).__send; return { connected: !!s.node?.isConnected, mid: s.node?.getAttribute('data-mid'), cls: s.node?.className, maxCopies: s.maxCopies, added: s.added, removed: s.removed, anims: s.anims, minOpacity: Math.min(...s.opacity) }; });
  const sameNode = (page: Page, text: string) => bubble(page, text).evaluate((n) => n === (window as unknown as { __send: { node: Element } }).__send.node);

  for (const mode of ['slow', 'late'] as const) {
    test('the bubble shows at once with a clock, then one tick, in the same node (' + (mode === 'slow' ? 'send answers first' : 'the stored copy arrives before the send answers') + ')', async ({ page }) => {
      await openChat(page);
      await page.waitForTimeout(500);
      await tune(page, mode);
      const text = 'Pedido confirmado, sai amanhã cedo';
      await follow(page, text);
      await field(page).fill(text);
      const t0 = Date.now();
      await field(page).press('Enter');
      const b = bubble(page, text);
      // at once: a normal bubble with a clock where the ticks go, long before the send answers
      await expect(b.getByLabel('Sending', { exact: true })).toBeVisible({ timeout: 400 });
      expect(Date.now() - t0).toBeLessThan(600);
      await expect(b).toHaveClass(/wa-pending/);
      await expect(b).toHaveAttribute('data-mid', /^pending-/);
      await expect(field(page)).toHaveValue('');
      await expect(b.getByLabel('Sent', { exact: true })).toHaveCount(0);
      if (mode === 'slow') await shot(page, 'dark-send-clock', { x: 440, y: 440, width: 840, height: 360 });
      // confirmed: the clock becomes a tick (or the ticks that followed), the bubble is the stored message now
      await expect(b.getByLabel(/^(Sent|Delivered|Read)$/)).toBeVisible({ timeout: 5000 });
      await expect(b.getByLabel('Sending', { exact: true })).toHaveCount(0);
      await expect(b).toHaveAttribute('data-mid', /^true_/, { timeout: 5000 });
      await expect(b).not.toHaveClass(/wa-pending/);
      await expect(b.getByLabel('Read', { exact: true })).toBeVisible({ timeout: 6000 });
      await expect(b).toHaveCount(1);
      expect(await sameNode(page, text)).toBe(true);
      const f = await followed(page);
      expect(f.connected).toBe(true);
      expect(f.maxCopies, 'never two bubbles of the same message').toBe(1);
      expect(f.added, 'one row was added').toBe(1);
      expect(f.removed, 'no row was removed').toBe(0);
      expect(f.anims, 'the enter animation ran once').toEqual(['wa-sent-in']);
      expect(f.cls).toContain('wa-sent-here');
      expect((await calls(page, '/send'))).toHaveLength(1);
      if (mode === 'slow') await shot(page, 'dark-send-read', { x: 440, y: 440, width: 840, height: 360 });
      // the row has its menu and actions now that it is a stored message
      await b.locator('.wa-bubble').hover();
      await expect(b.locator('.wa-chev')).toBeVisible();
    });
  }

  test('the pending bubble is not faded and does not jump when it is confirmed', async ({ page }) => {
    await openChat(page);
    await page.waitForTimeout(500);
    await tune(page, 'slow');
    const text = 'Sem salto na confirmação';
    await follow(page, text);
    await field(page).fill(text);
    await field(page).press('Enter');
    const b = bubble(page, text);
    await expect(b.getByLabel('Sending', { exact: true })).toBeVisible();
    await page.waitForTimeout(250); // the enter animation is over
    expect(await b.locator('.wa-bubble').evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    const before = (await b.locator('.wa-bubble').boundingBox())!;
    await expect(b.getByLabel('Sent', { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(b).toHaveAttribute('data-mid', /^true_/, { timeout: 5000 });
    const after = (await b.locator('.wa-bubble').boundingBox())!;
    expect(after).toEqual(before);
  });

  test('a send that fails keeps its bubble with a red mark and Retry; Retry sends it from the same bubble', async ({ page }) => {
    await openChat(page);
    await page.waitForTimeout(500);
    await tune(page, 'fail-once');
    const text = 'Esta precisa de duas tentativas';
    await follow(page, text);
    await field(page).fill(text);
    await field(page).press('Enter');
    const b = bubble(page, text);
    await expect(b.getByLabel('Sending', { exact: true })).toBeVisible();
    await expect(b.getByRole('group', { name: 'Message not sent' })).toBeVisible({ timeout: 4000 });
    await expect(b.getByLabel('Not sent', { exact: true })).toBeVisible();
    await expect(page.getByText('Message not sent').first()).toBeVisible();
    await expect(field(page)).toHaveValue('');
    const red = await b.locator('.wa-failrow').evaluate((e) => { const g = document.createElement('canvas').getContext('2d')!; g.fillStyle = getComputedStyle(e).color; g.fillRect(0, 0, 1, 1); return Array.from(g.getImageData(0, 0, 1, 1).data); });
    expect(red[0]).toBeGreaterThan(red[1] + 60);
    expect(red[0]).toBeGreaterThan(red[2] + 60);
    await shot(page, 'dark-send-failed', { x: 440, y: 440, width: 840, height: 360 });
    await b.getByRole('button', { name: 'Retry' }).click();
    await expect(b.getByRole('group', { name: 'Message not sent' })).toHaveCount(0);
    await expect(b.getByLabel(/^(Sent|Delivered|Read)$/)).toBeVisible({ timeout: 5000 });
    await expect(b).toHaveAttribute('data-mid', /^true_/, { timeout: 5000 });
    await expect(b).toHaveCount(1);
    expect(await sameNode(page, text)).toBe(true);
    const f = await followed(page);
    expect(f.maxCopies).toBe(1);
    expect(f.removed).toBe(0);
    const tries = await page.evaluate(() => (window as unknown as { __sendTries: unknown[] }).__sendTries);
    expect(tries).toHaveLength(2);
    expect(tries[1]).toEqual(tries[0]);
    expect(tries[0]).toEqual({ chatId: '5511987654321@c.us', text });
  });

  test('a failed bubble can be deleted, and the next message still goes out', async ({ page }) => {
    await openChat(page, 'light');
    await field(page).fill('isto #fail');
    await field(page).press('Enter');
    const b = bubble(page, 'isto #fail');
    await expect(b.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 4000 });
    await shot(page, 'light-send-failed', { x: 440, y: 440, width: 840, height: 360 });
    await field(page).fill('Agora vai');
    await field(page).press('Enter');
    await expect(bubble(page, 'Agora vai').getByLabel(/^(Sent|Delivered|Read)$/)).toBeVisible({ timeout: 5000 });
    await expect(b).toHaveCount(1);
    await b.getByRole('button', { name: 'Delete' }).click();
    await expect(b).toHaveCount(0);
    await expect(bubble(page, 'Agora vai')).toHaveCount(1);
  });

  test('reduced motion: the bubble appears without the enter animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openChat(page);
    await field(page).fill('Sem animação');
    await field(page).press('Enter');
    const b = bubble(page, 'Sem animação');
    await expect(b).toBeVisible();
    expect(await b.locator('.wa-bw').evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
  });
});
