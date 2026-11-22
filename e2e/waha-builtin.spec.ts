import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1100, height: 900 } });
const SHOTS = '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
const url = (section: string, extra = '') => `/e2e/harness/waha-builtin.html?section=${section}${extra}`;

async function openConfig(page: import('@playwright/test').Page) {
  await page.locator('[data-plugin="waha"]').getByRole('button', { name: /Configure/ }).click();
  await expect(page.locator('[data-slot="whatsapp-server-card"]')).toBeVisible();
}

test('status card: running, in use, health check', async ({ page }) => {
  await page.goto(url('plugins'));
  await openConfig(page);
  const card = page.locator('[data-slot="whatsapp-server-card"]');
  await expect(card.getByText('Running 2026.10.1, NOWEB')).toBeVisible();
  await expect(card.getByText('In use', { exact: true })).toBeVisible();
  await expect(card.getByText('WhatsApp is linked through WAHA, an unofficial client. WhatsApp may restrict or ban numbers that send spam or bulk messages. Use it for normal conversations.')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Powered by WAHA Core (Apache-2.0)' })).toHaveAttribute('href', 'https://github.com/devlikeapro/waha');
  await card.getByRole('button', { name: 'Check health' }).click();
  await expect(card.getByText('Healthy, answered in 42 ms')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/waha-builtin-status.png` });
});

test('status card: health failure is shown', async ({ page }) => {
  await page.goto(url('plugins', '&health=fail'));
  await openConfig(page);
  await page.getByRole('button', { name: 'Check health' }).click();
  await expect(page.getByText('Health check failed: Connection refused')).toBeVisible();
});

test('status card: plugin uses an external server', async ({ page }) => {
  await page.goto(url('plugins', '&mode=external&theme=dark'));
  await openConfig(page);
  await expect(page.getByText('Not used: this plugin points at an external WAHA address')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/waha-builtin-external.png` });
});

test('updates: row with update, confirm, auto-update switch and minutes save', async ({ page }) => {
  await page.goto(url('runtime'));
  const row = page.locator('div', { has: page.getByText('WhatsApp server', { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Update', exact: true }) }).last();
  await expect(page.getByText('WhatsApp server', { exact: true })).toBeVisible();
  await expect(page.getByText('Installed 2026.10.1 / latest 2026.11.2')).toBeVisible();
  const sw = page.getByRole('switch', { name: 'Update the WhatsApp server automatically' });
  await expect(sw).toBeVisible();
  await expect(page.getByText('Checks once a day and updates when no message was sent or received for 30 minutes, never during a QR login.')).toBeVisible();
  await expect(page.getByText(/Last automatic update/)).toBeVisible();
  await sw.click();
  await expect(sw).toBeChecked();
  const mins = page.getByLabel('Quiet minutes before an automatic WhatsApp server update');
  await mins.fill('45');
  await mins.blur();
  await expect(page.getByText(/no message was sent or received for 45 minutes/)).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__calls);
  expect(calls.filter((c: any) => c.name === 'auto').map((c: any) => c.args)).toEqual([{ enabled: true }, { quietMinutes: 45 }]);
  await page.getByText('WhatsApp server', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/waha-builtin-updates-available.png` });
  void row;
});

test('updates: external server shows update available without an Update button', async ({ page }) => {
  await page.goto(url('runtime', '&scenario=external&theme=dark'));
  await expect(page.getByText('Runs outside Floq: update it where it is hosted')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Update the WhatsApp server automatically' })).toHaveCount(0);
  await page.getByText('WhatsApp server', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/waha-builtin-updates-external.png` });
});

test('updates: whatsapp_busy offers Update anyway and retries with force', async ({ page }) => {
  await page.goto(url('runtime', '&scenario=busy'));
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByText('WhatsApp disconnects for about a minute while the server restarts. Sessions and media are kept. If the new version does not come up healthy, Floq puts the previous one back.')).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByRole('alertdialog').getByText('WhatsApp is in use')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/waha-builtin-updates-busy.png` });
  await page.getByRole('button', { name: 'Update anyway' }).click();
  await expect(page.getByText('WhatsApp server updated')).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__calls);
  expect(calls.filter((c: any) => c.name === 'apply').map((c: any) => c.args)).toEqual([{ target: 'whatsapp', force: false }, { target: 'whatsapp', force: true }]);
});

test('updates: QR login in progress shows an error, no force offered', async ({ page }) => {
  await page.goto(url('runtime', '&scenario=login'));
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByText('A QR login is in progress')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update anyway' })).toHaveCount(0);
});
