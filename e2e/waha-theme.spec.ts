// The WhatsApp (WAHA) plugin follows Floq's appearance settings: theme (class "dark"), material (data-material, data-native-material) and accent (--primary),
// live and with no colours of its own. Rendered from the plugin's BUILT package inside the app's .workspace-frame, where the host styles every input and textarea.
// Point WAHA_PLUGIN_DIR at the plugin checkout (after `npm run build` there). WAHA_SHOTS=dir writes waha-acrylic-*.png into that directory.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const pluginDir = process.env.WAHA_PLUGIN_DIR ?? path.resolve(process.env.HOME ?? '.', 'work/floq-plugin-waha');
const dist = path.join(pluginDir, 'dist');
const pkgFile = existsSync(dist) ? readdirSync(dist).find((f) => /^waha-.*\.floqpkg\.json$/.test(f)) : undefined;
const shots = process.env.WAHA_SHOTS;
const WIDE = { width: 1280, height: 800 }, NARROW = { width: 390, height: 780 };
const CLEAR = 'rgba(0, 0, 0, 0)';

test.skip(!pkgFile, 'no built WAHA plugin package: set WAHA_PLUGIN_DIR and run npm run build there');

// What Settings > Appearance writes on <html>: a translucent material comes with data-native-material when the window itself is translucent.
const MATERIALS = [
  { id: 'glass', query: '' },
  { id: 'acrylic', query: 'material=acrylic&native=acrylic' },
  { id: 'mica', query: 'material=mica&native=mica' },
  { id: 'vibrancy', query: 'material=vibrancy&native=vibrancy' },
  { id: 'solid', query: 'material=solid' },
];
const q = (theme: string, material: string, extra = '') => ['frame=1', theme === 'dark' ? 'theme=dark' : '', material, extra].filter(Boolean).join('&');

async function open(page: Page, query: string, size = WIDE) {
  await page.setViewportSize(size);
  await page.route('**/__waha/pkg.json', (route) => route.fulfill({ contentType: 'application/json', body: readFileSync(path.join(dist, pkgFile!), 'utf8') }));
  await page.goto('/e2e/harness/waha.html?' + query);
  await expect(page.locator('.wa-root')).toBeVisible();
}
const row = (page: Page, name: string) => page.locator('.wa-row', { hasText: name });
async function openChat(page: Page, query: string, size = WIDE) {
  await open(page, query, size);
  await row(page, 'Marina Costa').click();
  await expect(page.locator('.wa-composer')).toBeVisible();
  await expect(page.locator('.wa-msg').first()).toBeVisible();
}
async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shots, `waha-acrylic-${name}.png`) });
}
/** Computed colours of the parts that carry the theme. A probe resolves the plugin's aliases, so nothing here names a colour. */
const read = (page: Page) => page.evaluate(() => {
  const root = document.querySelector<HTMLElement>('.wa-root')!;
  const css = (sel: string, prop: 'backgroundColor' | 'color' = 'backgroundColor') => { const e = root.querySelector(sel); return e ? getComputedStyle(e)[prop] : ''; };
  const probe = document.createElement('i'); root.appendChild(probe);
  const token = (v: string) => { probe.style.background = v; return getComputedStyle(probe).backgroundColor; };
  const out = {
    root: getComputedStyle(root).backgroundColor, text: getComputedStyle(root).color, blur: getComputedStyle(root).backdropFilter, wall: css('.wa-chat-pane'), mine: css('.wa-mine .wa-bubble'), theirs: css('.wa-theirs .wa-bubble'),
    bar: css('.wa-composer'), field: css('.wa-cfield'), textarea: css('.wa-cfield textarea'), search: css('.wa-search input'), badge: css('.wa-pill'),
    card: token('var(--card)'), primary: token('var(--primary)'), pill: token('var(--wa-pill)'), nativeCanvas: token('var(--native-canvas-pane)'),
  };
  probe.remove();
  return out;
});
/** Alpha of a computed colour: "rgb(1 2 3)", "rgba(1, 2, 3, 0.5)", "oklab(0.9 0 0 / 0.76)", "color(srgb 1 1 1 / 0.4)". */
const alpha = (c: string) => { const m = /\/\s*([\d.]+)\s*\)$/.exec(c) ?? /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(c); return m ? Number(m[1]) : 1; };

for (const theme of ['light', 'dark']) {
  for (const m of MATERIALS) {
    test(`${theme} ${m.id}: the host's input rules never paint inside the plugin's fields`, async ({ page }) => {
      await openChat(page, q(theme, m.query));
      const c = await read(page);
      // The message field is a transparent textarea inside the pill; before the fix the host's .workspace-frame textarea rule painted a card-coloured box in it.
      expect(c.textarea).toBe(CLEAR);
      expect(c.search).toBe(c.pill);
      expect(c.search).not.toBe(c.card);
      await page.locator('.wa-cfield textarea').fill('Typing a message');
      await expect(page.locator('.wa-cfield textarea')).toBeFocused();
      const focused = await page.locator('.wa-cfield textarea').evaluate((e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, shadow: s.boxShadow, border: s.borderTopWidth }; });
      expect(focused).toEqual({ bg: CLEAR, shadow: 'none', border: '0px' });
      // Solid is fully opaque; every other material lets the workspace (or the desktop) through the panes.
      if (m.id === 'solid') { expect(alpha(c.root)).toBe(1); expect(alpha(c.bar)).toBe(1); expect(alpha(c.wall)).toBe(1); expect(c.blur).toBe('none'); }
      else expect(alpha(c.root)).toBeLessThan(1);
      // With a translucent window the chat is the canvas pane of the native material.
      if (m.query.includes('native=')) expect(c.wall).toBe(c.nativeCanvas);
      await shot(page, `chat-${m.id}-${theme}`);
    });
  }
}

test('theme, material and accent switch on the open inbox with no reload', async ({ page }) => {
  await openChat(page, q('light', ''));
  await page.evaluate(() => { (window as unknown as { __alive: number }).__alive = 1; });
  const html = (fn: string) => page.evaluate(`(() => { const h = document.documentElement; ${fn} })()`);
  const light = await read(page);
  expect(alpha(light.root)).toBeLessThan(1);
  expect(light.badge).toBe(light.primary);

  await html('h.classList.add("dark")');
  const dark = await read(page);
  for (const k of ['root', 'text', 'wall', 'mine', 'theirs', 'bar', 'field'] as const) expect(dark[k], k).not.toBe(light[k]);

  await html('h.dataset.material = "solid"');
  const solid = await read(page);
  expect(alpha(solid.root)).toBe(1);
  expect(solid.root).toBe(solid.card);
  expect(solid.blur).toBe('none');

  for (const material of ['acrylic', 'mica', 'vibrancy']) {
    await html(`h.dataset.material = "${material}"; h.dataset.nativeMaterial = "${material}"`);
    const c = await read(page);
    expect(alpha(c.root), material).toBeLessThan(1);
    expect(c.wall, material).toBe(c.nativeCanvas);
    expect(c.wall, material).not.toBe(solid.wall);
    expect(c.textarea, material).toBe(CLEAR);
  }

  await html('delete h.dataset.material; delete h.dataset.nativeMaterial; h.classList.remove("dark")');
  await expect(async () => expect(await read(page)).toEqual(light)).toPass({ timeout: 3000 }); // the host's inputs fade their colours

  // The accent is the host's --primary, whatever it is.
  await html('h.style.setProperty("--primary", "rgb(0, 120, 255)")');
  const blue = await read(page);
  expect(blue.badge).toBe('rgb(0, 120, 255)');
  expect(blue.mine).not.toBe(light.mine);
  expect(await page.evaluate(() => (window as unknown as { __alive?: number }).__alive)).toBe(1);
});

// Screens beyond the chat, for the two ends of the range: translucent (native acrylic) and solid.
for (const theme of ['light', 'dark']) {
  for (const m of MATERIALS.filter((x) => x.id === 'acrylic' || x.id === 'solid')) {
    test(`${theme} ${m.id}: screens`, async ({ page }) => {
      await open(page, q(theme, m.query));
      await expect(row(page, 'Marina Costa')).toBeVisible();
      await shot(page, `list-${m.id}-${theme}`);
      await row(page, 'Marina Costa').click();
      await expect(page.locator('.wa-msg').first()).toBeVisible();
      await shot(page, `composer-empty-${m.id}-${theme}`);
      await page.locator('.wa-cfield textarea').fill('On my way, see you at 3');
      await shot(page, `composer-typing-${m.id}-${theme}`);
      await page.getByRole('button', { name: 'Emoji', exact: false }).first().click();
      await shot(page, `emoji-${m.id}-${theme}`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'New chat' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await shot(page, `dialog-${m.id}-${theme}`);
      await page.keyboard.press('Escape');

      await open(page, q(theme, m.query, 'state=qr'));
      await page.getByRole('button', { name: 'Link again' }).click();
      await expect(page.getByRole('img', { name: /QR/i }).first()).toBeVisible();
      await shot(page, `qr-${m.id}-${theme}`);

      await openChat(page, q(theme, m.query), NARROW);
      await page.locator('.wa-cfield textarea').fill('Narrow');
      expect((await read(page)).textarea).toBe(CLEAR);
      await shot(page, `narrow-${m.id}-${theme}`);
    });
  }
}

test('a hovered chat row shrinks its preview so the menu button never covers text', async ({ page }) => {
  await open(page, q('dark', 'material=acrylic&native=acrylic'));
  const wrap = page.locator('.wa-rowwrap', { hasText: 'Unknown contact' });
  await wrap.hover();
  const menu = wrap.locator('.wa-rowmenu');
  await expect(menu).toBeVisible();
  const [m, p] = await Promise.all([menu.boundingBox(), wrap.locator('.wa-line').last().locator('.wa-preview').boundingBox()]);
  expect(p!.x + p!.width).toBeLessThanOrEqual(m!.x);
  const pill = wrap.locator('.wa-pill');
  if (await pill.count()) { const b = (await pill.boundingBox())!; expect(b.x + b.width).toBeLessThanOrEqual(m!.x); }
});

for (const theme of ['dark', 'light']) {
  test(`empty conversation: welcome text sits on a solid card over the faint canvas dots (${theme})`, async ({ page }) => {
    await open(page, q(theme, 'material=acrylic&native=acrylic'));
    const hello = page.locator('.wa-hello');
    await expect(hello).toBeVisible();
    const bg = await hello.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    if (shots) { mkdirSync(shots, { recursive: true }); await page.mouse.move(0, 0); await page.waitForTimeout(350); await page.screenshot({ path: path.join(shots, `waha-readable-empty-${theme}.png`) }); }
  });
}
