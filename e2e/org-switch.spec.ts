import { expect, test, type Page } from '@playwright/test';

const base = 'https://runtime.org-switch.test';
const user = { id: 'u1', name: 'Ari', email: 'ari@example.test' };
const org = (id: string, personal = false) => ({ id, name: id, slug: id, role: 'owner', personal, members: [] });
const project = (id: string, organizationId: string) => ({ id, name: id, displayName: null, imageUrl: null, iconName: null, iconColor: null, gitUrl: null, cwd: '/p/' + id, organizationId, createdAt: '2026-11-12T00:00:00Z', workspaces: [] });
const byOrg: Record<string, ReturnType<typeof project>[]> = { personal: [project('p-personal', 'personal')], team: [project('p-team', 'team')] };

/** `delayTeam`: hold the team project list until released, to prove a stale response is dropped. */
async function setup(page: Page, opts: { delayPersonal?: boolean } = {}) {
  const seen: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.addInitScript(({ user, base }) => {
    localStorage.setItem('floq.connection', JSON.stringify({ baseUrl: base, token: 't', user }));
    class Quiet { onopen = null; onmessage = null; onclose = null; onerror = null; readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} }
    (window as unknown as { WebSocket: unknown }).WebSocket = Quiet;
  }, { user, base });
  await page.route(base + '/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const header = req.headers()['x-floq-organization'] ?? 'personal';
    if (path === '/v1/projects') {
      seen.push(header);
      if (opts.delayPersonal && header === 'personal') await gate;
    }
    const value = path === '/api/auth/get-session' ? { user }
      : path === '/v1/organizations' ? { organizations: [org('personal', true), org('team')] }
      : path === '/v1/projects' ? { projects: byOrg[header] ?? [] }
      : path === '/v1/sessions' ? { sessions: [] }
      : {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  });
  return { seen, release: () => release() };
}

const list = (page: Page) => page.getByTestId('projects');

test('switching swaps the project list and sends the org header', async ({ page }) => {
  const { seen } = await setup(page);
  await page.goto('/e2e/harness/org-switch.html');
  await expect(list(page)).toContainText('p-personal');
  await page.getByText('switch team').click();
  await expect(list(page)).toContainText('p-team');
  await expect(list(page)).not.toContainText('p-personal');
  expect(seen).toContain('team');
  expect(seen[0]).toBe('personal'); // never fetched header-less before the org was known
});

test('an open canvas goes home on switch and is restored per org', async ({ page }) => {
  await setup(page);
  await page.goto('/e2e/harness/org-switch.html');
  await page.getByText('open p-personal').click();
  await expect(page.getByTestId('view')).toHaveText('canvas:p-personal');
  await page.getByText('switch team').click();
  await expect(page.getByTestId('view')).toHaveText('home:');
  await expect(list(page)).toContainText('p-team');
  await page.getByText('switch personal').click();
  await expect(page.getByTestId('view')).toHaveText('canvas:p-personal');
});

test('a slow response from the old org is dropped', async ({ page }) => {
  const { release } = await setup(page, { delayPersonal: true });
  await page.goto('/e2e/harness/org-switch.html');
  await expect(page.getByTestId('org')).toHaveText('personal');
  await page.getByText('switch team').click();
  await expect(list(page)).toContainText('p-team');
  release();
  await page.waitForTimeout(300);
  await expect(list(page)).toContainText('p-team');
  await expect(list(page)).not.toContainText('p-personal');
});
