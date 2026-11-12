import { expect, test, type Page } from '@playwright/test';

const base = 'https://runtime.org-edit.test';
const user = { id: 'u1', name: 'Ari', email: 'ari@example.test' };
// 1x1 transparent PNG; the page crops/resizes it to 256px before upload.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

type MockOrg = { id: string; name: string; slug: string; role: string; personal: boolean; imageUrl: string | null; members: unknown[] };

/** Stateful mock of the organization endpoints. `role` is the signed-in user's role in the team org. */
async function setup(page: Page, opts: { role?: string } = {}) {
  const orgs: MockOrg[] = [
    { id: 'personal', name: 'Personal', slug: '', role: 'owner', personal: true, imageUrl: null, members: [{ id: 'u1', name: 'Ari', email: user.email, role: 'owner' }] },
    { id: 'team', name: 'Acme', slug: 'acme', role: opts.role ?? 'owner', personal: false, imageUrl: null, members: [{ id: 'u1', name: 'Ari', email: user.email, role: opts.role ?? 'owner' }] },
  ];
  const taken = new Set(['acme', 'globex']);
  const log = { patches: [] as Record<string, unknown>[], uploads: [] as { type: string; size: number }[], checks: [] as string[], removed: 0 };
  let image: Buffer | null = null;
  let version = 0;
  await page.addInitScript(({ user, base }) => {
    localStorage.setItem('floq.connection', JSON.stringify({ baseUrl: base, token: 't', user }));
    class Quiet { onopen = null; onmessage = null; onclose = null; onerror = null; readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} }
    (window as unknown as { WebSocket: unknown }).WebSocket = Quiet;
  }, { user, base });
  await page.route(base + '/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/v1/organizations/slug-available') {
      const slug = url.searchParams.get('slug') ?? '';
      log.checks.push(slug);
      const own = orgs.find((o) => o.id === url.searchParams.get('excludeId'))?.slug;
      if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) return json({ slug, normalized: slug, available: false, reason: 'invalid' });
      if (['admin', 'api', 'settings', 'new'].includes(slug)) return json({ slug, normalized: slug, available: false, reason: 'reserved' });
      if (taken.has(slug) && slug !== own) return json({ slug, normalized: slug, available: false, reason: 'taken' });
      return json({ slug, normalized: slug, available: true });
    }
    const orgRoute = /^\/v1\/organizations\/([\w-]+)(\/image)?$/.exec(path);
    if (orgRoute && req.method() === 'PATCH') {
      const patch = req.postDataJSON() as { name?: string; slug?: string };
      log.patches.push(patch);
      const org = orgs.find((o) => o.id === orgRoute[1])!;
      if (patch.slug && patch.slug !== org.slug && taken.has(patch.slug)) return json({ error: { code: 'slug_taken', message: 'That URL name is already taken' } }, 409);
      if (patch.name) org.name = patch.name;
      if (patch.slug) { taken.delete(org.slug); taken.add(patch.slug); org.slug = patch.slug; }
      return json({ ok: true });
    }
    if (orgRoute?.[2] === '/image') {
      const org = orgs.find((o) => o.id === orgRoute[1])!;
      if (req.method() === 'PUT') {
        const body = req.postDataBuffer();
        log.uploads.push({ type: req.headers()['content-type'] ?? '', size: body?.length ?? 0 });
        image = body; version += 1;
        org.imageUrl = `/v1/organizations/${org.id}/image?v=${version}`;
        return json({ ok: true });
      }
      if (req.method() === 'DELETE') { image = null; org.imageUrl = null; log.removed += 1; return json({ ok: true }); }
      if (req.method() === 'GET' && image) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    const value = path === '/api/auth/get-session' ? { user }
      : path === '/v1/organizations' ? { organizations: orgs }
      : path === '/v1/projects' ? { projects: [] }
      : path === '/v1/sessions' ? { sessions: [] }
      : path === '/v1/me/organization-invitations' || path.endsWith('/invitations') ? { invitations: [] }
      : {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  });
  return { orgs, log };
}

const slugStatus = (page: Page) => page.getByTestId('slug-status');
const urlInput = (page: Page) => page.getByLabel('URL name', { exact: true });

async function open(page: Page, org: 'personal' | 'team' = 'team') {
  await page.goto('/e2e/harness/org-edit.html');
  await expect(page.getByTestId('active-name')).not.toHaveText('');
  if (org === 'team') await page.getByText('switch team').click();
  await expect(page.getByTestId('active-name')).toHaveText(org === 'team' ? 'Acme' : 'Personal');
}

test.use({ viewport: { width: 900, height: 900 } });

test('rename saves on blur and refreshes the list', async ({ page }) => {
  const { log } = await setup(page);
  await open(page);
  const name = page.getByLabel('Name', { exact: true });
  await name.fill('  Acme   Labs ');
  await name.blur();
  await expect(page.getByTestId('active-name')).toHaveText('Acme Labs');
  expect(log.patches).toEqual([{ name: 'Acme Labs' }]);
});

test('URL name: checking, taken, reserved, invalid, available, then save', async ({ page }) => {
  const { log, orgs } = await setup(page);
  await open(page);
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await expect(slugStatus(page)).toHaveAttribute('data-state', 'unchanged');

  await urlInput(page).fill('globex');
  await expect(slugStatus(page)).toHaveAttribute('data-state', 'checking');
  await expect(slugStatus(page)).toHaveAttribute('data-state', 'taken');
  await expect(save).toBeDisabled();

  await urlInput(page).fill('admin');
  await expect(slugStatus(page)).toHaveAttribute('data-state', 'reserved');
  await expect(save).toBeDisabled();

  const checksBefore = log.checks.length;
  await urlInput(page).fill('x');
  await expect(slugStatus(page)).toHaveAttribute('data-state', 'invalid'); // local rule: no request
  await expect(save).toBeDisabled();
  expect(log.checks.length).toBe(checksBefore);

  await urlInput(page).fill('acme-labs');
  await expect(slugStatus(page)).toHaveAttribute('data-state', 'available');
  await expect(page.getByTestId('slug-preview')).toContainText('runtime.org-edit.test/acme-labs');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(slugStatus(page)).toHaveAttribute('data-state', 'unchanged');
  expect(orgs[1].slug).toBe('acme-labs');
  expect(log.patches).toEqual([{ slug: 'acme-labs' }]);
});

test('typing fast only checks the last value (300 ms debounce)', async ({ page }) => {
  const { log } = await setup(page);
  await open(page);
  await urlInput(page).clear();
  await urlInput(page).pressSequentially('fresh-name', { delay: 20 });
  await expect(slugStatus(page)).toHaveAttribute('data-state', 'available');
  expect(log.checks.filter((s) => s !== 'acme')).toEqual(['fresh-name']);
});

test('image: pick uploads a square PNG/WebP, shows in the switcher, remove falls back to initials', async ({ page }) => {
  const { log } = await setup(page);
  await open(page);
  const probe = page.getByTestId('switcher-probe').getByTestId('org-avatar');
  await expect(probe).toHaveAttribute('data-has-image', 'false');
  await page.getByTestId('org-image-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(probe).toHaveAttribute('data-has-image', 'true');
  await expect(page.getByTestId('org-image-drop').getByTestId('org-avatar')).toHaveAttribute('data-has-image', 'true');
  expect(log.uploads).toHaveLength(1);
  expect(['image/webp', 'image/png']).toContain(log.uploads[0].type);
  expect(log.uploads[0].size).toBeLessThan(512 * 1024);
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(probe).toHaveAttribute('data-has-image', 'false');
  expect(log.removed).toBe(1);
});

test('image: a non-image file is refused before any upload', async ({ page }) => {
  const { log } = await setup(page);
  await open(page);
  await page.getByTestId('org-image-input').setInputFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByText('Could not update the image')).toBeVisible();
  expect(log.uploads).toHaveLength(0);
});

test('personal organization: name and image, no URL name row', async ({ page }) => {
  const { log } = await setup(page);
  await open(page, 'personal');
  await expect(page.getByText('has no URL name')).toBeVisible();
  await expect(urlInput(page)).toHaveCount(0);
  await expect(page.getByTestId('org-image-input')).toHaveCount(1);
  const name = page.getByLabel('Name', { exact: true });
  await name.fill('My space');
  await name.blur();
  await expect(page.getByTestId('active-name')).toHaveText('My space');
  expect(log.patches).toEqual([{ name: 'My space' }]);
});

test('members without rights see it read-only', async ({ page }) => {
  await setup(page, { role: 'member' });
  await open(page);
  await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
  await expect(urlInput(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('org-image-input')).toHaveCount(0);
});

for (const theme of ['dark', 'light'] as const) {
  test(`screenshot: ${theme}`, async ({ page }) => {
    await setup(page);
    await page.emulateMedia({ colorScheme: theme });
    await open(page);
    await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
    await page.getByTestId('org-image-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('org-image-drop').getByTestId('org-avatar')).toHaveAttribute('data-has-image', 'true');
    await urlInput(page).fill('acme-labs');
    await expect(slugStatus(page)).toHaveAttribute('data-state', 'available');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `.tmp/shots/org-edit-${theme}.png`, fullPage: true });
  });
}
