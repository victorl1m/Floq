import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1100, height: 900 } });

const calls = (page: Page) => page.evaluate(() => (window as any).__calls as { cmd: string; args: unknown }[]);
const modes = (page: Page) => page.evaluate(() => (window as any).__modes as string[]);
const toggle = (page: Page) => page.getByRole('switch', { name: 'Route browser traffic through this computer' });

test.describe('Settings > Browser egress', () => {
  test('web build only says it is available in the desktop app', async ({ page }) => {
    await page.goto('/e2e/harness/egress.html?tauri=0');
    await expect(page.getByTestId('egress-web-note')).toHaveText('Available in the desktop app');
    await expect(page.getByRole('switch')).toHaveCount(0);
  });

  test('desktop: off by default, with the honest help text and nothing extra shown', async ({ page }) => {
    await page.goto('/e2e/harness/egress.html');
    await expect(toggle(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText('Websites will see your internet connection and location instead of Floq')).toBeVisible();
    await expect(page.getByText('Agents can then browse as you, from your IP.')).toBeVisible();
    const help = page.getByTestId('egress-help');
    await expect(help).toContainText('does not make the browser look human');
    await expect(help).toContainText('challenges may still appear');
    await expect(help).toContainText('Time zone and language stay the server');
    await expect(help).toContainText('you are responsible');
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    await expect(page.getByTestId('egress-advanced')).toHaveCount(0);
    expect((await calls(page)).filter((c) => c.cmd === 'egress_start')).toHaveLength(0);
  });

  test('turning it on saves "desktop", offers the offline choice (pause by default) and survives a reload', async ({ page }) => {
    await page.goto('/e2e/harness/egress.html');
    await toggle(page).click();
    await expect.poll(() => modes(page)).toEqual(['desktop']);
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
    const group = page.getByRole('radiogroup', { name: 'If this computer is offline' });
    await expect(group.getByRole('radio', { name: /Pause the browser/ })).toBeChecked();
    await expect(page.getByTestId('egress-status')).toContainText('2 connections');
    await expect(page.getByText('This computer: Work-Laptop')).toBeVisible();
    await group.getByRole('radio', { name: /Use the server's connection/ }).check();
    await expect.poll(() => modes(page)).toEqual(['desktop', 'desktop-fallback']);
    await expect(page.getByTestId('mode')).toHaveText('desktop-fallback');
    // This machine's choice is local state: with the runtime mode still "desktop-fallback" the toggle is on after a reload.
    await page.goto('/e2e/harness/egress.html?mode=desktop-fallback');
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
    // ... and on another computer (nothing in its local storage) it is off.
    await page.evaluate(() => localStorage.clear());
    await page.goto('/e2e/harness/egress.html?mode=desktop-fallback');
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
  });

  test('"Stop using my connection" is the kill switch: stops the relay and saves "server"', async ({ page }) => {
    await page.goto('/e2e/harness/egress.html');
    await toggle(page).click();
    await expect(page.getByTestId('egress-stop')).toBeVisible();
    await page.getByTestId('egress-stop').click();
    await expect.poll(() => modes(page)).toEqual(['desktop', 'server']);
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
    expect((await calls(page)).some((c) => c.cmd === 'egress_stop')).toBe(true);
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
  });

  test('a failed save leaves it off', async ({ page }) => {
    await page.goto('/e2e/harness/egress.html?fail=1');
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('mode')).toHaveText('server');
  });

  test('Advanced: cap and other ports persist locally, recent connections list what the IP was used for', async ({ page }) => {
    await page.goto('/e2e/harness/egress.html');
    await toggle(page).click();
    await page.getByTestId('egress-advanced').locator('summary').click();
    const ports = page.getByRole('switch', { name: 'Allow other ports' });
    await expect(ports).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText('Your local network stays blocked either way.')).toBeVisible();
    await ports.click();
    await page.getByTestId('egress-cap').click();
    await page.getByRole('option', { name: '50 GB' }).click();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('floq.browserEgress.policy')!));
    expect(stored).toEqual({ allowOtherPorts: true, dailyCapBytes: 50 * 1024 ** 3 });
    // The relay would restart with this policy: it is what the Rust side receives.
    await page.getByTestId('egress-recent-toggle').click();
    const recent = page.getByTestId('egress-recent');
    await expect(recent.getByText('example.com:443')).toBeVisible();
    await expect(recent.getByText('localhost:3000')).toBeVisible();
    await expect(recent.getByText('denied')).toBeVisible();
    await expect(recent.getByText('20 KB')).toBeVisible();
    await expect(page.getByText('never sent anywhere')).toBeVisible();
  });
});

// --- Browser node badge and paused overlay (uses the shared browser harness; the runtime pushes `egress` messages) ---
async function openNode(page: Page) {
  await page.goto('/e2e/harness/browser.html');
  await expect(page.getByTestId('browser-node')).toBeVisible();
  await expect(page.getByTestId('browser-frame')).toBeVisible();
}
const push = (page: Page, msg: unknown) => page.evaluate((m) => (window as any).__push(m), msg);

test.describe('Browser node egress badge', () => {
  test('no badge until the runtime reports egress (older runtimes)', async ({ page }) => {
    await openNode(page);
    await expect(page.getByTestId('browser-egress-badge')).toHaveCount(0);
  });

  test('via your connection, via server, and the fallback wording', async ({ page }) => {
    await openNode(page);
    const badge = page.getByTestId('browser-egress-badge');
    await push(page, { type: 'egress', mode: 'desktop', state: 'up', machine: 'Work-Laptop', rttMs: 41.6 });
    await expect(badge).toHaveText('via your connection');
    await expect(badge).toHaveAttribute('data-tone', 'green');
    await expect(badge).toHaveAttribute('title', /Work-Laptop · 42 ms/);
    await expect(page.getByTestId('browser-egress-paused')).toHaveCount(0);

    await push(page, { type: 'egress', mode: 'server', state: 'down' });
    await expect(badge).toHaveText('via server');
    await expect(badge).toHaveAttribute('data-tone', 'neutral');

    await push(page, { type: 'egress', mode: 'desktop-fallback', state: 'down' });
    await expect(badge).toHaveText('via server (your computer is offline)');
    await expect(badge).toHaveAttribute('data-tone', 'amber');
    await expect(page.getByTestId('browser-egress-paused')).toHaveCount(0);
  });

  test('paused: overlay explains it, fails closed, and "Use server connection this time" is transient (setting untouched)', async ({ page }) => {
    await openNode(page);
    await push(page, { type: 'egress', mode: 'desktop', state: 'down' });
    const badge = page.getByTestId('browser-egress-badge');
    await expect(badge).toHaveText('paused');
    await expect(badge).toHaveAttribute('data-tone', 'amber');
    const overlay = page.getByTestId('browser-egress-paused');
    await expect(overlay).toContainText("The browser uses your computer's connection and Floq isn't open there");
    await expect(overlay).toContainText('Open Floq on your computer, or switch to the server connection');
    await overlay.getByRole('button', { name: 'Settings' }).click();
    expect(await page.evaluate(() => (window as any).__settings)).toBe(1);
    await overlay.getByRole('button', { name: 'Use server connection this time' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__overrides)).toEqual([true]);
    expect(await page.evaluate(() => (window as any).__patches), 'the saved mode is not touched').toEqual([]);
    await push(page, { type: 'egress', mode: 'desktop', state: 'down', override: true });
    await expect(badge).toHaveText('via server (this time)');
    await expect(overlay).toHaveCount(0);
    await push(page, { type: 'egress', mode: 'desktop', state: 'down' });
    // The reconnect clears the overlay by itself once the runtime says the desktop is up.
    await push(page, { type: 'egress', mode: 'desktop', state: 'up', machine: 'Work-Laptop' });
    await expect(overlay).toHaveCount(0);
  });
});
