// Settings > Integrations > WhatsApp (built into Floq; the former catalog plugin "waha"). Harness: e2e/harness/integrations-main.tsx.
import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1180, height: 940 } });
const SHOTS = process.env.FLOQ_SHOTS_DIR ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
const url = (extra = '') => `/e2e/harness/integrations.html?${extra}`;
const card = (page: Page) => page.locator('[data-slot="whatsapp-integration"]');
const calls = (page: Page, name: string) => page.evaluate((n) => (window as any).__calls.filter((c: any) => c.name === n).map((c: any) => c.args), name);
const shot = async (page: Page, name: string) => { await page.waitForTimeout(350); await page.screenshot({ path: `${SHOTS}/integrations-${name}.png` }); };

test('Integrations is a settings section of its own and WhatsApp is not a plugin any more', async ({ page }) => {
  await page.goto(url('server=builtin&enabled=1'));
  await expect(page.getByRole('button', { name: 'Integrations', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
  await expect(card(page)).toBeVisible();
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await expect(page.locator('[data-plugin="movidesk"]')).toBeVisible();
  await expect(page.locator('[data-plugin="waha"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="whatsapp-server-card"]')).toHaveCount(0);
});

test('no WhatsApp server: nothing to enable, an explanation and the two ways to get one', async ({ page }) => {
  await page.goto(url('server=none'));
  await expect(card(page)).toHaveAttribute('data-state', 'none');
  await expect(card(page).getByText('No server', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: /WhatsApp/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open WhatsApp' })).toHaveCount(0);
  const help = page.locator('[data-slot="whatsapp-no-server"]');
  await expect(help.getByText('WhatsApp needs a WhatsApp server (WAHA)')).toBeVisible();
  await expect(help.getByText('Run the built-in server beside Floq.')).toBeVisible();
  await expect(help.locator('pre')).toHaveText('COMPOSE_PROFILES=whatsapp\nFLOQ_WHATSAPP_API_KEY=<openssl rand -hex 32>');
  await expect(help.getByText('Connect a WAHA server you already run.')).toBeVisible();
  await expect(help.getByRole('button', { name: 'Connect a WAHA server' })).toBeVisible();
  await expect(page.locator('[data-slot="whatsapp-settings"]')).toHaveCount(0);
  await shot(page, 'no-server-light');
});

test('no WhatsApp server, dark on acrylic', async ({ page }) => {
  await page.goto(url('server=none&theme=dark&material=acrylic&native=acrylic'));
  await expect(page.locator('[data-slot="whatsapp-no-server"]')).toBeVisible();
  await shot(page, 'no-server-dark-acrylic');
});

test('external server: tested before it can be saved, then WhatsApp can be enabled', async ({ page }) => {
  await page.goto(url('server=none'));
  await page.getByRole('button', { name: 'Connect a WAHA server' }).click();
  const form = page.locator('[data-slot="whatsapp-external-form"]');
  const test_ = form.getByRole('button', { name: 'Test connection' }), save = form.getByRole('button', { name: 'Save and connect' });
  await expect(test_).toBeDisabled();
  await expect(save).toBeDisabled();
  await form.getByLabel('WAHA address').fill('https://waha.example.com');
  await form.getByLabel('API key').fill('wrong-key');
  await expect(form.getByLabel('API key')).toHaveAttribute('type', 'password');
  await expect(save).toBeDisabled(); // not tested yet
  await test_.click();
  await expect(form.locator('[data-slot="whatsapp-test-result"]')).toHaveText('The server answered, but it refused this API key.');
  await expect(save).toBeDisabled();
  await shot(page, 'external-test-failed-light');
  await form.getByLabel('API key').fill('good-key');
  await expect(form.locator('[data-slot="whatsapp-test-result"]')).toHaveCount(0); // the old verdict is for other values
  await test_.click();
  await expect(form.locator('[data-slot="whatsapp-test-result"]')).toHaveText('Connected: WAHA 2026.10.1 (NOWEB). You can save it now.');
  await expect(save).toBeEnabled();
  // Editing after the test locks Save again: only tested values are stored.
  await form.getByLabel('WAHA address').fill('https://other.example.com');
  await expect(save).toBeDisabled();
  await test_.click();
  await expect(form.locator('[data-slot="whatsapp-test-result"]')).toHaveText('The server could not be reached: connection refused');
  await form.getByLabel('WAHA address').fill('https://waha.example.com');
  await test_.click();
  await expect(save).toBeEnabled();
  await shot(page, 'external-test-ok-light');
  expect(await calls(page, 'savePluginSettings')).toEqual([]);
  await save.click();
  await expect(card(page)).toHaveAttribute('data-state', 'external');
  expect(await calls(page, 'setPluginSecret')).toEqual([{ id: 'waha', name: 'WAHA_API_KEY', length: 8 }]);
  expect(await calls(page, 'savePluginSettings')).toEqual([{ id: 'waha', settings: { baseUrl: 'https://waha.example.com' } }]);
  await expect(page.locator('[data-slot="whatsapp-no-server"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="whatsapp-server"]')).toContainText('https://waha.example.com');
  // Now it can be turned on.
  const sw = page.getByRole('switch', { name: 'Enable WhatsApp' });
  await expect(sw).not.toBeChecked();
  await sw.click();
  await expect(page.getByRole('switch', { name: 'Disable WhatsApp' })).toBeChecked();
  expect(await calls(page, 'setPluginEnabled')).toEqual([{ id: 'waha', on: true, level: 'install' }]);
  await expect(page.locator('[data-slot="whatsapp-connection"]')).toContainText('Connected as Ana Souza, +5511988887777');
  await shot(page, 'external-connected-light');
});

test('external server: change and disconnect', async ({ page }) => {
  await page.goto(url('server=external&enabled=1&theme=dark&material=solid'));
  await expect(card(page)).toHaveAttribute('data-state', 'external');
  await expect(card(page).getByText('External server', { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="whatsapp-server-card"]')).toHaveCount(0); // no built-in server here
  await shot(page, 'external-dark-solid');
  await page.locator('[data-slot="whatsapp-server"]').getByRole('button', { name: 'Change' }).click();
  await expect(page.locator('[data-slot="whatsapp-external-form"]').getByLabel('WAHA address')).toHaveValue('https://waha.example.com');
  await page.locator('[data-slot="whatsapp-external-form"]').getByRole('button', { name: 'Cancel' }).click();
  await page.locator('[data-slot="whatsapp-server"]').getByRole('button', { name: 'Disconnect' }).click();
  await expect(card(page)).toHaveAttribute('data-state', 'none');
  expect(await calls(page, 'savePluginSettings')).toEqual([{ id: 'waha', settings: { messageMe: true } }]); // the other settings stay
  expect(await calls(page, 'deletePluginSecret')).toEqual([{ id: 'waha', name: 'WAHA_API_KEY' }]);
});

test('built-in server available: enable, status, accounts, webhook health, settings, open WhatsApp, disable', async ({ page }) => {
  await page.goto(url('server=builtin&accounts=2'));
  await expect(card(page)).toHaveAttribute('data-state', 'builtin');
  await expect(card(page).getByText('Built-in server', { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="whatsapp-no-server"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open WhatsApp' })).toHaveCount(0);
  await expect(page.locator('[data-slot="whatsapp-connection"]')).toContainText('Turn WhatsApp on');
  await shot(page, 'builtin-off-light');
  await page.getByRole('switch', { name: 'Enable WhatsApp' }).click();
  await expect(page.getByText('WhatsApp turned on')).toBeVisible();
  await expect(card(page)).toHaveAttribute('data-enabled', 'true');
  await expect(page.locator('[data-slot="whatsapp-connection"]')).toContainText('Connected as Ana Souza, +5511988887777');
  const accounts = page.locator('[data-slot="whatsapp-accounts"]');
  await expect(accounts.locator('[data-account="default"]')).toHaveText('Ana Souza (+5511988887777): connected, 3 unread');
  await expect(accounts.locator('[data-account="work"]')).toHaveText('Work (+5511977776666): waiting for the qr code scan');
  await expect(page.locator('[data-slot="whatsapp-webhook"]')).toContainText('Webhook delivering every event');
  await expect(page.locator('[data-slot="whatsapp-server"]')).toContainText('Built-in server beside Floq');
  // The built-in server's own card (state, health check, notice) sits inside the WhatsApp card.
  const server = page.locator('[data-slot="whatsapp-server-card"]');
  await expect(server.getByText('Running 2026.10.1, NOWEB')).toBeVisible();
  await server.getByRole('button', { name: 'Check health' }).click();
  await expect(server.getByText('Healthy, answered in 42 ms')).toBeVisible();
  // Settings the plugin had: own number + test message, the AI switches; the address is not a field here.
  await page.locator('[data-slot="whatsapp-settings"]').getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('#whatsapp-settings-region');
  await expect(settings.getByText('Your WhatsApp number')).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Send test message' })).toBeVisible();
  await expect(settings.getByLabel('Let the AI message me freely')).toBeVisible();
  await expect(settings.getByLabel('Always allow AI to send messages')).toBeVisible();
  await expect(settings.getByLabel('WAHA address')).toHaveCount(0);
  await settings.getByLabel('Let the AI message me freely').click();
  await settings.locator('[data-slot="plugin-settings-form"]').getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByText('WhatsApp settings saved')).toBeVisible();
  expect((await calls(page, 'savePluginSettings')).at(-1)).toEqual({ id: 'waha', settings: { messageMe: true, alwaysAllowSend: false } });
  await shot(page, 'builtin-on-light');
  // Open WhatsApp: the inbox view, with Settings closed.
  await page.getByRole('button', { name: 'Open WhatsApp' }).click();
  expect(await calls(page, 'navigate')).toEqual([{ view: 'plugin', arg: 'waha/inbox' }]);
  await expect(page.locator('[data-slot="settings-closed"]')).toBeVisible();
});

test('built-in server, WhatsApp on: dark on acrylic, dark solid, light on acrylic; disable', async ({ page }) => {
  for (const [name, extra] of [['builtin-on-dark-acrylic', 'theme=dark&material=acrylic&native=acrylic'], ['builtin-on-dark-solid', 'theme=dark&material=solid'], ['builtin-on-light-acrylic', 'material=acrylic&native=acrylic'], ['builtin-on-light-solid', 'material=solid']] as const) {
    await page.goto(url('server=builtin&enabled=1&' + extra));
    await expect(page.locator('[data-slot="whatsapp-webhook"]')).toContainText('Webhook delivering every event');
    await expect(page.locator('[data-slot="whatsapp-server-card"]')).toBeVisible();
    await shot(page, name);
  }
  await page.getByRole('switch', { name: 'Disable WhatsApp' }).click();
  await expect(page.getByText('WhatsApp turned off')).toBeVisible();
  await expect(card(page)).toHaveAttribute('data-enabled', 'false');
  await expect(page.getByRole('button', { name: 'Open WhatsApp' })).toHaveCount(0);
  expect(await calls(page, 'setPluginEnabled')).toEqual([{ id: 'waha', on: false, level: 'install' }]);
});

test('status rows say what is wrong: QR code pending, webhook events missing, no account yet', async ({ page }) => {
  await page.goto(url('server=builtin&enabled=1&session=SCAN_QR_CODE&webhook=partial'));
  await expect(page.locator('[data-slot="whatsapp-connection"]')).toContainText('Waiting for the QR code scan');
  await expect(page.locator('[data-slot="whatsapp-webhook"]')).toContainText('Webhook set, 2 event types missing');
  await shot(page, 'builtin-qr-pending-light');
  await page.goto(url('server=builtin&enabled=1&session=MISSING'));
  await expect(page.locator('[data-slot="whatsapp-connection"]')).toContainText('No account linked yet');
  await expect(page.locator('[data-slot="whatsapp-accounts"]')).toContainText('Open WhatsApp and scan the QR code');
});

test('webhook health from Floq\'s own check: a missing webhook is repaired from the card', async ({ page }) => {
  await page.goto(url('server=builtin&enabled=1&health=missing'));
  const row = page.locator('[data-slot="whatsapp-webhook"]');
  await expect(row).toContainText('The WhatsApp server has no webhook to Floq: new messages will not arrive');
  await shot(page, 'builtin-webhook-missing-light');
  await row.getByRole('button', { name: 'Repair webhook' }).click();
  await expect(page.getByText('Webhook repaired')).toBeVisible();
  await expect(row).toContainText('Webhook delivering every event');
  await expect(row.getByRole('button', { name: 'Repair webhook' })).toHaveCount(0);
  expect((await calls(page, 'pluginFetch')).filter((c: any) => c.path === '/session/webhook-repair')).toEqual([{ id: 'waha', path: '/session/webhook-repair', method: 'POST' }]);
});

test('a member sees that an administrator manages WhatsApp and gets no controls', async ({ page }) => {
  await page.goto(url('server=builtin&enabled=1&role=member'));
  await expect(card(page)).toHaveAttribute('data-state', 'member');
  await expect(page.locator('[data-slot="whatsapp-member-note"]')).toHaveText('WhatsApp is set up by an administrator of this runtime and belongs to their account.');
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open WhatsApp' })).toHaveCount(0);
  await expect(page.locator('[data-slot="whatsapp-settings"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="whatsapp-server-card"]')).toHaveCount(0);
  await shot(page, 'member-light');
});

test('Plugins: a deprecated installed plugin is badged; Browse hides deprecated ones for new installs and WhatsApp altogether', async ({ page }) => {
  await page.goto(url('server=builtin&section=plugins'));
  const old = page.locator('[data-plugin="oldie"]');
  await expect(old.locator('[data-slot="plugin-deprecated"]')).toHaveText('Deprecated');
  await expect(old.getByText('Old Tracker is now part of Floq: Tasks > Sources.')).toBeVisible();
  await expect(page.locator('[data-plugin="movidesk"] [data-slot="plugin-deprecated"]')).toHaveCount(0);
  await shot(page, 'plugins-deprecated-light');
  await page.getByRole('button', { name: 'Browse plugins' }).click();
  await expect(page.locator('[data-plugin-card="azure-devops"]')).toBeVisible();
  await expect(page.locator('[data-plugin-card="oldie"] [data-slot="plugin-deprecated"]')).toBeVisible(); // installed: still listed, so it can be removed
  await expect(page.locator('[data-plugin-card="gone"]')).toHaveCount(0);
  await expect(page.locator('[data-plugin-card="waha"]')).toHaveCount(0);
  await shot(page, 'plugins-browse-deprecated-light');
});
