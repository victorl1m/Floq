import { expect, test } from '@playwright/test';

const calls = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __calls: Array<{ name: string; args: unknown }> }).__calls);
const AUTH_URL = 'https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&code_challenge_method=S256';

test('Antigravity Google sign-in: URL, paste code, connected, disconnect', async ({ page }) => {
  await page.routeWebSocket('ws://agy.test/stream', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', server: {}, truncated: 0, session: { id: 'login-1', provider: 'antigravity', state: 'running', startedAt: 1, seq: 1 } }));
    ws.send(JSON.stringify({ type: 'output', seq: 1, ts: 1, data: `Open this link in a browser to log in with Google:\r\n  ${AUTH_URL}\r\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\r\n` }));
  });
  await page.goto('/e2e/harness/agy-login.html');
  await expect(page.getByTestId('usable')).toHaveText('');
  await expect(page.getByText('Google account (Gemini subscription)')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Connect Antigravity')).toBeVisible();
  await expect(dialog.getByText(/copy the code shown on antigravity\.google/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Open/ }).first()).toBeVisible();
  await dialog.getByLabel('Authorization code').fill('4/0AbCdEf');
  await dialog.getByRole('button', { name: 'Submit code' }).click();
  await expect.poll(async () => (await calls(page)).find((c) => c.name === 'input')?.args).toEqual(['login-1', '4/0AbCdEf\r']);
  await expect(dialog.getByText('Antigravity is connected.')).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect.poll(async () => (await calls(page)).some((c) => c.name === 'logout' && c.args === 'antigravity')).toBe(true);
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
});

test('Antigravity login failure text is shown', async ({ page }) => {
  await page.routeWebSocket('ws://agy.test/stream', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', server: {}, truncated: 0, session: { id: 'login-1', provider: 'antigravity', state: 'running', startedAt: 1, seq: 1 } }));
    ws.send(JSON.stringify({ type: 'output', seq: 1, ts: 1, data: 'couldn\'t log in: token exchange failed: invalid_grant\r\n' }));
  });
  await page.goto('/e2e/harness/agy-login.html');
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  await expect(page.getByRole('dialog').getByText(/couldn.t log in: token exchange failed/).first()).toBeVisible();
});

test('already signed in shows Connected and makes Antigravity usable without an API key', async ({ page }) => {
  await page.goto('/e2e/harness/agy-login.html?connected=1');
  await expect(page.getByTestId('usable')).toHaveText('antigravity');
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
});
