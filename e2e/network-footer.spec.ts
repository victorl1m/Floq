import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1000, height: 720 } });
const ART = process.env.FLOQ_ARTIFACTS_DIR ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
const calls = (page: Page) => page.evaluate(() => (window as any).__calls as { cmd: string; args: unknown }[]);
const trigger = (page: Page) => page.getByTestId('network-footer');

test('footer item is "Network" (no "Ports") and shows the forwarded count', async ({ page }) => {
  await page.goto('/e2e/harness/network.html');
  await expect(trigger(page)).toContainText('Network');
  await expect(trigger(page)).not.toContainText('Ports');
  await expect(trigger(page)).toContainText('1');
  await expect(trigger(page)).toHaveAttribute('aria-label', /^Network: 1 port forwarded/);
  await expect(page.getByTestId('network-egress-indicator')).toHaveCount(0);
  await trigger(page).click();
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('network-egress-state')).toHaveText("Not used: the agent browser goes out through Floq's server.");
  await expect(page.getByText('Port forwarding')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop forwarding port 5173' })).toBeVisible();
  await page.screenshot({ path: `${ART}/network-footer-off.png` });
});

test('egress active: live indicator in the footer, details in the popover, Stop calls egress_stop and saves "server"', async ({ page }) => {
  await page.goto('/e2e/harness/network.html?egress=up');
  const ind = page.getByTestId('network-egress-indicator');
  await expect(ind).toBeVisible();
  await expect(ind).toHaveAttribute('data-tone', 'green');
  await expect(ind).toContainText('Using your connection');
  await expect(ind).toContainText('15');
  await expect(trigger(page)).toHaveAttribute('aria-label', /using your connection \(15 connections\)/);
  await page.screenshot({ path: `${ART}/network-footer-indicator.png`, clip: { x: 500, y: 660, width: 500, height: 60 } });

  // Keyboard: focus the trigger and open it with Enter.
  await trigger(page).focus();
  await page.keyboard.press('Enter');
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
  const details = page.getByTestId('network-egress-details');
  await expect(details).toContainText('Work-Laptop');
  await expect(details).toContainText('Active connections15');
  await expect(details).toContainText('2.3 MB/min');
  await expect(details).toContainText('38 ms');
  await expect(details).toContainText('412.0 MB of 10.00 GB');
  await expect(details).toContainText('Since');
  const hosts = page.getByTestId('network-egress-hosts');
  await expect(hosts.locator('li').first()).toContainText('www.google.com');
  await expect(hosts.locator('li').first()).toContainText('2×');
  await expect(hosts).toContainText('192.168.1.10'); // web ports (80/443) are not repeated
  await expect(hosts).toContainText('1 blocked');
  await expect(page.getByRole('button', { name: 'Stop forwarding port 5173' })).toBeVisible();
  await page.screenshot({ path: `${ART}/network-footer-popover.png` });

  await page.getByTestId('network-egress-stop').click();
  await expect.poll(async () => (await calls(page)).some((c) => c.cmd === 'egress_stop')).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__patches)).toEqual([{ agentBrowserEgress: 'server' }]);
  await expect(page.getByTestId('network-egress-indicator')).toHaveCount(0);
  await expect(page.getByTestId('network-egress-start')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('floq.browserEgress.here'))).toBe('0');
});

test('"Use my connection" turns it back on (saves "desktop", this computer chosen)', async ({ page }) => {
  await page.goto('/e2e/harness/network.html?relay=1');
  await trigger(page).click();
  await page.getByTestId('network-egress-start').click();
  await expect.poll(() => page.evaluate(() => (window as any).__patches)).toEqual([{ agentBrowserEgress: 'desktop' }]);
  expect(await page.evaluate(() => localStorage.getItem('floq.browserEgress.here'))).toBe('1');
  // The relay host reacts to the setting event and starts the Rust relay.
  await expect.poll(async () => (await calls(page)).some((c) => c.cmd === 'egress_start')).toBe(true);
});

test('paused egress shows an amber indicator and the reason', async ({ page }) => {
  await page.goto('/e2e/harness/network.html?egress=paused');
  await expect(page.getByTestId('network-egress-indicator')).toHaveAttribute('data-tone', 'amber');
  await trigger(page).click();
  await expect(page.getByTestId('network-egress-state')).toHaveText('Paused: daily limit reached');
  await expect(page.getByTestId('network-egress-stop')).toBeVisible();
});

test('the floating notice shows only briefly when the connection starts being used', async ({ page }) => {
  await page.clock.install();
  await page.goto('/e2e/harness/network.html?egress=up&relay=1');
  const notice = page.getByTestId('egress-indicator');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('15 connections');
  await page.clock.runFor(7000);
  await expect(notice).toHaveCount(0);
  // The footer keeps the live indicator.
  await expect(page.getByTestId('network-egress-indicator')).toBeVisible();
});

test('web build: no indicator, the popover explains it needs the desktop app', async ({ page }) => {
  await page.goto('/e2e/harness/network.html?tauri=0');
  await trigger(page).click();
  await expect(page.getByTestId('network-egress')).toContainText('needs the desktop app');
  await expect(page.getByTestId('network-egress-stop')).toHaveCount(0);
});
