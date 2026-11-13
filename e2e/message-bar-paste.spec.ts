import { expect, test } from '@playwright/test';

const base = 'https://runtime.msgbar.test';
const user = { id: 'u1', name: 'Ari', email: 'ari@example.test' };

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('Ctrl+V of text in the empty message bar pastes into the input and sends nothing to the PTY', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:1420' });
  const inputs: unknown[] = [];
  await page.addInitScript(({ user, base }) => {
    localStorage.setItem('floq.connection', JSON.stringify({ baseUrl: base, token: 't', user }));
    class Quiet { onopen = null; onmessage = null; onclose = null; onerror = null; readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} }
    (window as unknown as { WebSocket: unknown }).WebSocket = Quiet;
  }, { user, base });
  await page.route(base + '/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    let value: unknown = {};
    if (path === '/api/auth/get-session') value = { user };
    else if (path === '/v1/info') value = { server: { name: 'floq-runtime', version: '0', startedAt: '2026-11-12T00:00:00Z', providers: ['claude'], maxSessions: 9, activeSessions: 0 }, providers: [], githubConfigured: false };
    else if (path === '/v1/organizations') value = { organizations: [{ id: 'personal', name: 'p', slug: 'p', role: 'owner', personal: true, members: [] }] };
    else if (path === '/v1/projects') value = { projects: [] };
    else if (path === '/v1/sessions') value = { sessions: [] };
    else if (path.endsWith('/input')) inputs.push(req.postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.goto('/e2e/harness/message-bar.html');
  const input = page.getByRole('textbox', { name: 'Message Agent' });
  await input.focus();
  await page.evaluate(() => navigator.clipboard.writeText('hello from clipboard'));
  await page.keyboard.press('Control+V');
  await expect(input).toHaveValue('hello from clipboard');
  // A control key on the still-empty bar keeps driving the terminal, proving the mock would have caught \x16.
  await input.fill('');
  await page.keyboard.press('Control+O');
  await expect.poll(() => inputs.length).toBe(1);
  expect(inputs).toEqual([{ data: '\x0f' }]);
  // Shift+Insert pastes too and is not forwarded.
  await page.keyboard.press('Shift+Insert');
  await expect(input).toHaveValue('hello from clipboard');
  expect(inputs).toHaveLength(1);
});
