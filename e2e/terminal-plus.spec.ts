import { expect, test } from '@playwright/test';

const base = 'https://runtime.terminal-plus.test';
const user = { id: 'u1', name: 'Ari', email: 'ari@example.test' };
const shell = (id: string) => ({ id, provider: 'shell', title: 'Terminal', state: 'running', cwd: '/home/ari', projectId: null, worktreeId: null, branch: null, cols: 80, rows: 24, createdAt: '2026-11-12T00:00:00Z', startedAt: null, endedAt: null, exitCode: null, signal: null, pid: null, seq: 0, bufferedBytes: 0, droppedBytes: 0, resumeCount: 0 });

test('Terminal view +: one click creates a plain shell session, no agent fields', async ({ page }) => {
  const created: Record<string, unknown>[] = [];
  let sessions: ReturnType<typeof shell>[] = [shell('s0')];
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
    else if (path === '/v1/info') value = { server: { name: 'floq-runtime', version: '0', startedAt: '2026-11-12T00:00:00Z', providers: ['shell', 'claude', 'codex'], maxSessions: 9, activeSessions: 0 }, providers: [], githubConfigured: false };
    else if (path === '/v1/organizations') value = { organizations: [{ id: 'personal', name: 'p', slug: 'p', role: 'owner', personal: true, members: [] }] };
    else if (path === '/v1/projects') value = { projects: [] };
    else if (path === '/v1/sessions' && req.method() === 'POST') {
      created.push(req.postDataJSON());
      const s = shell('s' + (sessions.length));
      sessions = [...sessions, s];
      value = { session: s };
    } else if (path === '/v1/sessions') value = { sessions };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('/e2e/harness/terminal-plus.html');
  const plus = page.getByRole('button', { name: 'New terminal' });
  await expect(plus).toBeVisible();
  const tabs = page.getByTestId('titlebar').getByRole('button', { name: /^Stop terminal/ });
  await expect(tabs).toHaveCount(1);
  await plus.click();
  await expect(page.getByRole('menu')).toHaveCount(0); // no provider menu
  await expect(tabs).toHaveCount(2);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ provider: 'shell' });
  for (const key of ['role', 'model', 'roleId', 'prompt', 'effort', 'orchestrator']) expect(created[0]).not.toHaveProperty(key);
  await page.screenshot({ path: '.tmp/shots/terminal-plus.png' });
});
