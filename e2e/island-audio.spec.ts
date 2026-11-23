import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

// Voice notes played from the island. Both halves run on one page (e2e/harness/island-audio.html) with Tauri mocked: the island card
// with its player, and the main-window bridge that really fetches the file with the runtime client and plays it. So a click on the card
// goes the whole way: intent -> bridge -> fetch -> <audio> -> snapshot -> card.
// ISLAND_AUDIO_SHOTS=dir (default: the Artifacts folder)
const shots = process.env.ISLAND_AUDIO_SHOTS ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

const voice = (id: string, over: Record<string, unknown> = {}, audio: Record<string, unknown> = { duration: 8, waveform: null }) => ({ id, userId: 'u', projectId: null, sessionId: null, sessionName: null, level: 'info', category: 'message',
  title: 'Marina Duarte', body: 'Voice message', action: null, createdAt: new Date().toISOString(), readAt: null,
  plugin: { id: 'waha', name: 'WhatsApp', icon: null, kind: 'message', subtitle: 'Shop', avatar: null, tag: 'shop:' + id, actions: [{ id: 'reply', label: 'Reply', input: { placeholder: 'Message' } }, { id: 'read', label: 'Mark read' }],
    target: { view: 'inbox', params: { chat: '5511900000001@c.us', session: 'shop' } }, audio }, ...over });

async function boot(page: Page, query = '') {
  await page.addInitScript(() => {
    const w = window as any;
    w.__published = []; w.__intents = []; w.__audios = []; w.isTauri = true;
    // Every <audio> the page creates (the bridge's engine makes exactly one) is kept for the assertions.
    const NativeAudio = w.Audio;
    w.Audio = function (...a: unknown[]) { const el = new NativeAudio(...a); el.volume = 0; w.__audios.push(el); return el; };
    const callbacks = new Map<number, (e: unknown) => void>(); const listeners: Record<string, number[]> = {}; let id = 1;
    w.__emit = (event: string, payload: unknown) => (listeners[event] ?? []).forEach(h => callbacks.get(h)?.({ event, id: 0, payload }));
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback(cb: (e: unknown) => void) { const n = id++; callbacks.set(n, cb); return n; },
      unregisterCallback() {}, convertFileSrc: (s: string) => s,
      async invoke(cmd: string, args: any) {
        if (cmd === 'plugin:event|listen') { (listeners[args.event] ??= []).push(args.handler); return id++; }
        if (cmd === 'plugin:event|unlisten') return;
        if (cmd === 'island_publish') { w.__published.push(args.snapshot); setTimeout(() => w.__emit('island:snapshot', JSON.parse(JSON.stringify(args.snapshot))), 0); return; }
        if (cmd === 'island_intent') { if (args.intent.type !== 'ready') w.__intents.push(args.intent); setTimeout(() => w.__emit('island:intent', JSON.parse(JSON.stringify(args.intent))), 0); return; }
        if (cmd === 'island_set_layout') return { width: args.expanded ? 440 : 220, height: args.expanded ? args.height : 40 };
        if (cmd === 'get_desktop_preferences') return { islandEnabled: true };
      },
    };
    // Per-frame sampler of the progress: where the knob is and how much of the bars is clipped.
    let frames: { t: number; x: number; clip: string }[] = []; let running = false;
    const tick = () => {
      if (!running) return;
      const knob = document.querySelector('.fq-audio-knob') as HTMLElement | null, on = document.querySelector('.fq-audio-bars-on') as HTMLElement | null;
      if (knob && on) frames.push({ t: performance.now(), x: new DOMMatrixReadOnly(getComputedStyle(knob).transform).m41, clip: on.style.clipPath });
      requestAnimationFrame(tick);
    };
    w.__progress = { start() { frames = []; running = true; requestAnimationFrame(tick); }, stop() { running = false; return frames; } };
  });
  await page.goto('/e2e/harness/island-audio.html' + query);
  await expect(page.getByTestId('bridge')).toHaveText('ready');
  await page.waitForTimeout(300); // the first (empty) notification snapshot has landed: later frames are "new"
}
const frame = (page: Page, n: object) => page.evaluate(x => (window as any).__frame({ type: 'notification', notification: x }), n);
const open = async (page: Page) => { await page.locator('.island').hover(); await expect(page.locator('.island.expanded')).toBeVisible(); await page.waitForTimeout(450); };
const collapse = async (page: Page) => { await page.mouse.move(220, 590); await expect(page.locator('.island.collapsed')).toBeVisible({ timeout: 3000 }); await page.waitForTimeout(400); };
const fetches = (page: Page) => page.evaluate(() => (window as any).__client.filter((c: any) => c.name === 'notificationAudio').map((c: any) => c.args[0] as string));
const playedCalls = (page: Page) => page.evaluate(() => (window as any).__client.filter((c: any) => c.name === 'notificationAudioPlayed').map((c: any) => c.args[0] as string));
const intents = (page: Page) => page.evaluate(() => (window as any).__intents.filter((i: any) => i.type === 'notification-audio') as { id: string; op: string; value?: number }[]);
const audio = (page: Page) => page.evaluate(() => { const all = (window as any).__audios as HTMLAudioElement[]; const el = all[all.length - 1]; return { count: all.length, sounding: all.filter(a => !a.paused).length, paused: el.paused, t: el.currentTime, rate: el.playbackRate, src: el.getAttribute('src') ?? '', duration: el.duration }; });
const published = (page: Page) => page.evaluate(() => (window as any).__published.at(-1) as { items: any[]; audio?: { id: string; status: string; position: number; rate: number; peaks: number[] | null } });
const card = (page: Page) => page.locator('.island-message');
const play = (page: Page) => card(page).getByRole('button', { name: 'Play voice message' });
const pause = (page: Page) => card(page).getByRole('button', { name: 'Pause voice message' });
const slider = (page: Page) => card(page).getByRole('slider', { name: 'Voice message position' });
const now = async (page: Page) => Number(await slider(page).getAttribute('aria-valuenow'));
async function start(page: Page, query = '', notes: object[] = [voice('v1')]) {
  await boot(page, query);
  for (const n of notes) await frame(page, n);
  await expect(page.locator('.island')).toBeVisible();
  await open(page);
  await expect(play(page)).toBeVisible();
}
const centreY = (page: Page, selector: string) => card(page).locator(selector).evaluate(e => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });

test('the card of a voice note shows a player; play fetches the audio once with the runtime client, plays it and tells the plugin', async ({ page }) => {
  await start(page);
  await expect(card(page).locator('.island-notification-body')).toHaveText('Voice message');
  await expect(card(page).locator('.fq-audio-time')).toHaveText('0:08'); // the length the plugin sent, before anything is loaded
  await expect(card(page).locator('.fq-audio-rate')).toHaveText('1x');
  expect(await fetches(page)).toEqual([]); // nothing is downloaded until the user asks
  await play(page).click();
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  expect(await intents(page)).toEqual([{ type: 'notification-audio', id: 'v1', op: 'play' }]);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  expect(await fetches(page)).toEqual(['v1']);
  await expect.poll(() => playedCalls(page)).toEqual(['v1']);
  const a = await audio(page);
  expect(a.src).toMatch(/^blob:/); // bytes fetched with the session, never a URL that works on its own
  await page.waitForTimeout(1300);
  await expect(card(page).locator('.fq-audio-time')).toHaveText('0:01');
  expect((await audio(page)).t).toBeGreaterThan(1);
  // the real waveform replaced the placeholder
  expect((await published(page)).audio?.peaks?.length).toBe(40);
  await pause(page).click();
  await expect(play(page)).toBeVisible();
  await expect.poll(async () => (await audio(page)).paused).toBe(true);
  const stopped = (await audio(page)).t;
  await page.waitForTimeout(500);
  expect((await audio(page)).t).toBe(stopped);
  expect(Math.abs(await now(page) - stopped)).toBeLessThanOrEqual(1);
  // play again: same file, no second download, no second "played"
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  expect(await fetches(page)).toEqual(['v1']);
  expect(await playedCalls(page)).toEqual(['v1']);
  expect((await audio(page)).t).toBeGreaterThanOrEqual(stopped);
});

test('progress moves on (nearly) every animation frame while playing and the card does not re-render', async ({ page }) => {
  await start(page);
  await play(page).click();
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  await page.waitForTimeout(600); // the decoded waveform has arrived: nothing left to render
  await page.evaluate(() => { (window as any).__fqAudioRenders = 0; (window as any).__progress.start(); });
  await page.waitForTimeout(1500);
  const frames = await page.evaluate(() => (window as any).__progress.stop() as { t: number; x: number; clip: string }[]);
  const renders = await page.evaluate(() => (window as any).__fqAudioRenders as number);
  expect(frames.length).toBeGreaterThan(12); // a loaded machine draws fewer frames; what matters is that each one moves
  const moved = frames.slice(1).filter((f, i) => f.x > frames[i].x && f.clip !== frames[i].clip).length;
  expect(moved / (frames.length - 1)).toBeGreaterThan(0.9);
  expect(frames.at(-1)!.x).toBeGreaterThan(frames[0].x + 30); // ~1.5 s of an 8 s note across a ~300px track
  expect(frames.slice(1).every((f, i) => f.x >= frames[i].x)).toBe(true); // never jumps back
  expect(renders).toBe(0);
  // paused: it stands still
  await pause(page).click();
  await expect(play(page)).toBeVisible();
  await page.waitForTimeout(200);
  await page.evaluate(() => (window as any).__progress.start());
  await page.waitForTimeout(400);
  const still = await page.evaluate(() => (window as any).__progress.stop() as { x: number }[]);
  expect(new Set(still.map(f => f.x)).size).toBe(1);
});

test('reduced motion: the progress steps once a second instead of every frame', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await start(page);
  await play(page).click();
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).__progress.start());
  await page.waitForTimeout(2100);
  const frames = await page.evaluate(() => (window as any).__progress.stop() as { x: number }[]);
  const distinct = new Set(frames.map(f => f.x)).size;
  expect(distinct).toBeGreaterThanOrEqual(2);
  expect(distinct).toBeLessThanOrEqual(4);
});

test('seek: a press on the waveform moves playback there; arrow keys step 5 seconds', async ({ page }) => {
  await start(page);
  await play(page).click();
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  const box = (await slider(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  await expect.poll(async () => (await audio(page)).t).toBeGreaterThanOrEqual(5.9);
  expect((await audio(page)).t).toBeLessThan(7.5);
  expect((await audio(page)).paused).toBe(false);
  expect(await now(page)).toBeGreaterThanOrEqual(6);
  const seeks = (await intents(page)).filter(i => i.op === 'seek');
  expect(seeks.length).toBe(1);
  expect(seeks[0].value).toBeGreaterThan(5.8);
  expect(seeks[0].value).toBeLessThan(6.2);
  // paused seeks stay paused
  await pause(page).click();
  await expect(play(page)).toBeVisible();
  await slider(page).focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await audio(page)).t).toBeLessThan(2.6);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await audio(page)).t).toBe(0);
  expect((await audio(page)).paused).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await audio(page)).t).toBe(5);
  await expect(card(page).locator('.fq-audio-time')).toHaveText('0:05');
});

test('a press on the waveform of a note that was never played starts it from there', async ({ page }) => {
  await start(page);
  const box = (await slider(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  const a = await audio(page);
  expect(a.t).toBeGreaterThanOrEqual(3.9);
  expect(a.t).toBeLessThan(5.5);
  expect(await fetches(page)).toEqual(['v1']);
});

test('speed: 1x, 1.5x, 2x and back, applied to the playing audio', async ({ page }) => {
  await start(page);
  const rate = card(page).locator('.fq-audio-rate');
  await play(page).click();
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  await rate.click();
  await expect(rate).toHaveText('1.5x');
  await expect(rate).toHaveAccessibleName('Playback speed 1.5x');
  await expect.poll(async () => (await audio(page)).rate).toBe(1.5);
  await rate.click();
  await expect(rate).toHaveText('2x');
  await expect.poll(async () => (await audio(page)).rate).toBe(2);
  // at 2x the card keeps up with the audio (it computes the position with the speed)
  const before = (await audio(page)).t;
  await page.waitForTimeout(1000);
  const after = (await audio(page)).t;
  expect(after - before).toBeGreaterThan(1.6);
  expect(Math.abs(await now(page) - after)).toBeLessThanOrEqual(1);
  expect((await audio(page)).paused).toBe(false);
  await rate.click();
  await expect(rate).toHaveText('1x');
  await expect.poll(async () => (await audio(page)).rate).toBe(1);
});

test('playback survives the card collapsing and expanding: it never restarts and nothing is fetched again', async ({ page }) => {
  await start(page, '?seconds=20', [voice('v1', {}, { duration: 20, waveform: null })]);
  await play(page).click();
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  await page.waitForTimeout(700);
  const before = await audio(page);
  await collapse(page);
  await expect(page.locator('.island-pill-playing')).toBeVisible(); // the pill says it is playing
  await page.waitForTimeout(900);
  const hidden = await audio(page);
  expect(hidden.paused).toBe(false);
  expect(hidden.t).toBeGreaterThan(before.t + 0.8);
  await open(page);
  await expect(pause(page)).toBeVisible();
  const after = await audio(page);
  expect(after.count).toBe(1);
  expect(after.src).toBe(before.src);
  expect(after.t).toBeGreaterThan(hidden.t);
  expect(Math.abs(await now(page) - after.t)).toBeLessThanOrEqual(1);
  expect(await fetches(page)).toEqual(['v1']);
  expect((await intents(page)).map(i => i.op)).toEqual(['play']);
  // again, twice in a row
  await collapse(page); await open(page); await collapse(page); await open(page);
  expect((await audio(page)).paused).toBe(false);
  expect((await audio(page)).t).toBeGreaterThan(after.t);
  expect(await fetches(page)).toEqual(['v1']);
});

test('dismissing the card stops the audio', async ({ page }) => {
  await start(page);
  await play(page).click();
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect.poll(async () => (await audio(page)).paused).toBe(true);
  expect((await audio(page)).src).toBe('');
  await expect.poll(async () => (await published(page)).audio).toBeUndefined();
  await page.waitForTimeout(600);
  expect((await audio(page)).sounding).toBe(0);
});

test('a notification that goes away by itself (read on the phone) stops the audio too', async ({ page }) => {
  await start(page);
  await play(page).click();
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  await page.evaluate(() => (window as any).__frame({ type: 'notification-cleared', ids: ['v1'] }));
  await expect.poll(async () => (await audio(page)).paused).toBe(true);
  expect((await audio(page)).src).toBe('');
});

test('only one audio plays at a time: starting another note stops the first', async ({ page }) => {
  const older = new Date(Date.now() - 5000).toISOString();
  await start(page, '', [voice('v1', { title: 'Marina Duarte', createdAt: older }), voice('v2', { title: 'Caio Prado' })]);
  await expect(card(page).locator('.island-notification-title')).toHaveText('Caio Prado');
  await play(page).click();
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  await page.waitForTimeout(600);
  expect((await published(page)).audio?.id).toBe('v2');
  const first = await audio(page);
  await page.getByRole('button', { name: 'Next request' }).click();
  await expect(card(page).locator('.island-notification-title')).toHaveText('Marina Duarte');
  // the other card is not playing: its own player is idle while the first note still sounds
  await expect(play(page)).toBeVisible();
  expect((await audio(page)).paused).toBe(false);
  await play(page).click();
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  const second = await audio(page);
  expect(second.count).toBe(1); // one element for the whole island
  expect(second.sounding).toBe(1);
  expect(second.src).not.toBe(first.src);
  expect(second.t).toBeLessThan(first.t + 0.5);
  expect((await published(page)).audio?.id).toBe('v1');
  expect(await fetches(page)).toEqual(['v2', 'v1']);
  // back on the first card: stopped, from the start
  await page.getByRole('button', { name: 'Previous request' }).click();
  await expect(card(page).locator('.island-notification-title')).toHaveText('Caio Prado');
  await expect(play(page)).toBeVisible();
  expect(await now(page)).toBe(0);
});

test('a busy WhatsApp server is tried again by itself: one press of play is enough', async ({ page }) => {
  await start(page, '?busy=1');
  await play(page).click();
  await expect(card(page).locator('.fq-audio-play')).toHaveAttribute('aria-busy', 'true');
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  expect(await fetches(page)).toEqual(['v1', 'v1']);
  expect((await intents(page)).map(i => i.op)).toEqual(['play']);
  await expect(card(page).getByRole('alert')).toHaveCount(0);
  expect((await audio(page)).paused).toBe(false);
});

test('audio that is gone says so and play can be pressed again', async ({ page }) => {
  await start(page, '?gone=1');
  await play(page).click();
  await expect(card(page).locator('.island-audio-error')).toHaveText('This audio is no longer available.');
  await expect(play(page)).toBeVisible();
  expect(await fetches(page)).toEqual(['v1']); // gone is final: no automatic tries
  await play(page).click();
  await expect.poll(() => fetches(page)).toEqual(['v1', 'v1']);
});

test('pause while the file is still loading: it does not start by itself afterwards', async ({ page }) => {
  await start(page, '?slow=900');
  await play(page).click();
  await expect(card(page).locator('.fq-audio-play')).toHaveAttribute('aria-busy', 'true');
  await card(page).locator('.fq-audio-play').click();
  await expect(play(page)).toBeVisible();
  await page.waitForTimeout(1400);
  await expect(play(page)).toBeVisible();
  expect((await audio(page)).paused).toBe(true);
  // the file is there now: the next play starts at once
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  expect(await fetches(page)).toEqual(['v1']);
});

test('listening keeps the card: no auto-dismiss while (or after) the note plays', async ({ page }) => {
  test.setTimeout(40_000);
  await start(page, '?seconds=20', [voice('v1', {}, { duration: 20, waveform: null })]);
  await play(page).click();
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  await page.waitForTimeout(13_500); // a message card leaves after 12 s when untouched
  await expect(card(page)).toBeVisible();
  expect((await audio(page)).paused).toBe(false);
  expect((await audio(page)).t).toBeGreaterThan(12);
});

test('reply and the other actions still work next to the player; a text message has no player', async ({ page }) => {
  await boot(page);
  await frame(page, voice('t1', { body: 'Can you send me the quote today?', plugin: { ...voice('x').plugin, audio: undefined } }));
  await open(page);
  await expect(card(page).locator('.fq-audio')).toHaveCount(0);
  await frame(page, voice('v1'));
  await expect(card(page).locator('.fq-audio')).toHaveCount(1);
  await expect(card(page).getByRole('textbox', { name: 'Reply to Marina Duarte' })).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Mark read' })).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Open chat', exact: true })).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme}: the play button, the waveform and the knob share one centre line, paused and playing; accent colours; screenshots`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await start(page, '', [voice('v1', { plugin: { ...voice('v1').plugin, subtitle: 'Ateliê Zoe · Família' } })]);
    mkdirSync(shots, { recursive: true });
    const aligned = async () => {
      const button = await centreY(page, '.fq-audio-play'), wave = await centreY(page, '.fq-audio-track'), bars = await centreY(page, '.fq-audio-bars:not(.fq-audio-bars-on)'), rate = await centreY(page, '.fq-audio-rate');
      const knob = await card(page).locator('.fq-audio-knob').evaluate(e => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });
      expect(Math.abs(button - wave)).toBeLessThanOrEqual(1);
      expect(Math.abs(button - bars)).toBeLessThanOrEqual(1);
      expect(Math.abs(button - knob)).toBeLessThanOrEqual(1);
      expect(Math.abs(button - rate)).toBeLessThanOrEqual(1);
      // the time sits under the waveform, clear of that line
      const time = (await card(page).locator('.fq-audio-time').boundingBox())!, track = (await card(page).locator('.fq-audio-track').boundingBox())!;
      expect(time.y).toBeGreaterThanOrEqual(track.y + track.height - 0.5);
      expect(Math.abs(time.x - track.x)).toBeLessThanOrEqual(1);
    };
    await aligned();
    // the island is dark in both schemes and follows the app's accent (--primary #f97316)
    expect(await card(page).locator('.fq-audio-play').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(249, 115, 22)');
    expect(await page.locator('.island').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(0, 0, 0)');
    await page.mouse.move(220, 300);
    await page.screenshot({ path: path.join(shots, `island-audio-${scheme}-idle.png`) });
    await play(page).click();
    await expect(pause(page)).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(2600);
    await aligned();
    expect(await card(page).locator('.fq-audio-bars-on i').first().evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(249, 115, 22)');
    await page.mouse.move(220, 300);
    await page.screenshot({ path: path.join(shots, `island-audio-${scheme}-playing.png`) });
    await card(page).locator('.fq-audio-rate').click();
    await card(page).locator('.fq-audio-rate').click();
    await pause(page).click();
    await expect(play(page)).toBeVisible();
    await aligned();
    await page.mouse.move(220, 300);
    await page.screenshot({ path: path.join(shots, `island-audio-${scheme}-paused-2x.png`) });
    await play(page).click();
    await expect(pause(page)).toBeVisible();
    await collapse(page);
    await page.screenshot({ path: path.join(shots, `island-audio-${scheme}-pill-playing.png`) });
  });
}

test('keyboard: the player is reachable with Tab and Space on the waveform toggles playback', async ({ page }) => {
  await start(page);
  await play(page).focus();
  await page.keyboard.press('Enter');
  await expect(pause(page)).toBeVisible({ timeout: 8000 });
  await page.keyboard.press('Tab');
  await expect(slider(page)).toBeFocused();
  await page.keyboard.press(' ');
  await expect(play(page)).toBeVisible();
  await expect.poll(async () => (await audio(page)).paused).toBe(true);
});
