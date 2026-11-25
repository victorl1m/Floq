import { expect, test, type Page } from '@playwright/test';

const open = async (page: Page, query = '') => {
  await page.goto(`/e2e/harness/fallback.html${query}`);
  await expect(page.getByText('Usage limits')).toBeVisible();
};
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: Array<{ name: string; args: Record<string, unknown> | unknown[] }> }).__calls);
const switchOf = (page: Page, name: string) => page.getByRole('switch', { name: new RegExp(name) });

test('T-13 defaults: master on, model downgrade and other accounts on, Codex off, swap-back on', async ({ page }) => {
  await open(page);
  await expect(switchOf(page, 'Keep agents working')).toBeChecked();
  await expect(switchOf(page, 'Smaller Claude model')).toBeChecked();
  await expect(switchOf(page, 'Another Claude account')).toBeChecked();
  await expect(switchOf(page, 'Codex')).not.toBeChecked();
  await expect(switchOf(page, 'Switch back after the reset')).toBeChecked();
  const items = page.getByRole('list', { name: 'Fallback order' }).getByRole('listitem');
  await expect(items.nth(0)).toContainText('Smaller Claude model');
});

test('T-13 reorder with the keyboard-accessible buttons persists the new order through the patch', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Move Codex up' }).focus();
  await page.keyboard.press('Enter');
  const patches = (await calls(page)).filter((c) => c.name === 'patch');
  expect(patches).toHaveLength(1);
  const steps = ((patches[0]!.args as { usageFallback: { steps: Array<{ kind: string }> } }).usageFallback).steps.map((s) => s.kind);
  expect(steps).toEqual(['model', 'codex', 'account']);
  const items = page.getByRole('list', { name: 'Fallback order' }).getByRole('listitem');
  await expect(items.nth(1)).toContainText('Codex');
  await expect(page.getByRole('button', { name: 'Move Smaller Claude model up' })).toBeDisabled();
});

test('T-13 toggling a step and the master switch patch the setting; steps lock when the master is off', async ({ page }) => {
  await open(page);
  await switchOf(page, 'Smaller Claude model').click();
  await switchOf(page, 'Keep agents working').click();
  const patches = (await calls(page)).filter((c) => c.name === 'patch').map((c) => (c.args as { usageFallback: { enabled: boolean; steps: Array<{ kind: string; enabled: boolean }> } }).usageFallback);
  expect(patches[0]!.steps[0]!.enabled).toBe(false);
  expect(patches[1]!.enabled).toBe(false);
  await expect(page.getByText('Smaller Claude model')).toBeHidden(); // steps are hidden while the fallback is off
});

for (const kind of ['model', 'paused']) {
  test(`T-13 badge (${kind}): shows state, popover has reset and origin, buttons call the API`, async ({ page }) => {
    await open(page, `?kind=${kind}&theme=dark`);
    const badge = page.getByTestId('fallback-badge');
    await expect(badge).toHaveAttribute('data-kind', kind);
    await expect(badge).toContainText(kind === 'paused' ? 'Paused' : 'Fallback: Sonnet');
    await badge.click();
    await expect(page.getByText('resets', { exact: false }).first()).toBeVisible();
    if (kind === 'model') {
      await expect(page.getByText('was Opus', { exact: false }).or(page.getByText('to Opus', { exact: false })).first()).toBeVisible();
      await page.getByRole('button', { name: 'Keep' }).click();
      await page.getByRole('button', { name: 'Return now' }).click();
      const c = (await calls(page)).filter((x) => x.name === 'fallbackAction').map((x) => (x.args as unknown[])[1]);
      expect(c).toEqual(['keep', 'return']);
    } else {
      await page.getByRole('button', { name: 'Resume now' }).click();
      const c = (await calls(page)).filter((x) => x.name === 'fallbackAction').map((x) => (x.args as unknown[])[1]);
      expect(c).toEqual(['return']);
    }
  });
}

test('T-13 accounts: every login is listed in order, arrows reorder, the trash icon removes any account (after confirming), the account step is on', async ({ page }) => {
  await open(page, '?accounts=1');
  await expect(page.getByRole('heading', { name: 'Claude accounts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make active' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(2); // the one in use too
  await page.getByRole('button', { name: 'Move Work up' }).click();
  await expect(page.getByRole('button', { name: 'Move Work up' })).toBeDisabled(); // Work is first now
  await page.getByRole('button', { name: 'Remove Primary' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(1);
  const names = (await calls(page)).filter((c) => ['reorder', 'remove'].includes(c.name)).map((c) => `${c.name}:${(c.args as string[]).join(',')}`);
  expect(names).toEqual(['reorder:acct_b0b0b0b0,primary', 'remove:primary']);
  await expect(switchOf(page, 'Another Claude account')).toBeChecked();
});

test('T-13 accounts: Add account opens the sign-in dialog', async ({ page }) => {
  await open(page, '?accounts=1');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('T-13 unavailable steps say why they are skipped (no second account, Codex not connected) and show nothing when available', async ({ page }) => {
  await open(page, '?single=1&codex=off');
  await expect(page.getByTestId('usage-fallback-account-unavailable')).toContainText('No second account connected');
  await expect(page.getByTestId('usage-fallback-codex-unavailable')).toContainText('Codex not connected');
  await open(page);
  await expect(page.getByTestId('usage-fallback-account-unavailable')).toHaveCount(0);
  await expect(page.getByTestId('usage-fallback-codex-unavailable')).toHaveCount(0);
});

test('T-13 badge: an account fallback reads "Fallback: Work" (no doubled word) and a Return refused as still limited explains itself', async ({ page }) => {
  await open(page, '?kind=account&still=1');
  const badge = page.getByTestId('fallback-badge');
  await expect(badge).toHaveText('Fallback: Work');
  await badge.click();
  await page.getByRole('button', { name: 'Return now' }).click();
  await expect(page.getByText('Your usage limit is still on')).toBeVisible();
});

test('T-13 per-agent policy: the card menu shows the current choice and saves Model only / Pause instead / default', async ({ page }) => {
  await open(page, '?policy=pause');
  const trigger = page.getByRole('button', { name: /On usage limit: Pause/ });
  await expect(trigger).toHaveAttribute('data-policy', 'pause');
  await trigger.click();
  await expect(page.getByRole('menuitemradio', { name: 'Pause' })).toBeChecked();
  await page.getByRole('menuitemradio', { name: 'Switch model only' }).click();
  await expect(page.getByRole('button', { name: /On usage limit: Switch model only/ })).toHaveAttribute('data-policy', 'model');
  await page.getByRole('button', { name: /On usage limit/ }).click();
  await page.getByRole('menuitemradio', { name: 'Keep going' }).click();
  const sent = (await calls(page)).filter((c) => c.name === 'fallbackAction').map((c) => (c.args as unknown[]).slice(1));
  expect(sent).toEqual([['override', 'model'], ['override', 'default']]);
});
