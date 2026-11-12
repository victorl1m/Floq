import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/e2e/harness/paste.html'); });

type Clip = { text?: string; html?: string; image?: string };
async function paste(page: Page, clip: Clip) {
  return page.evaluate((c) => {
    const box = document.getElementById('box') as HTMLElement;
    box.focus();
    const dt = new DataTransfer();
    if (c.text) dt.setData('text/plain', c.text);
    if (c.html) dt.setData('text/html', c.html);
    if (c.image) dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], c.image, { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    box.dispatchEvent(event);
    // Mimic the browser: insert the text only when the handler left the default action alone.
    if (!event.defaultPrevented && c.text) box.textContent += c.text;
    return { prevented: event.defaultPrevented, value: box.textContent, chips: Array.from(document.querySelectorAll('#chips li')).map((li) => li.textContent) };
  }, clip);
}

test('text only pastes as text, no chip', async ({ page }) => {
  const r = await paste(page, { text: 'hello world' });
  expect(r).toMatchObject({ prevented: false, value: 'hello world', chips: [] });
});
test('image only attaches a chip and inserts no text', async ({ page }) => {
  const r = await paste(page, { image: 'image.png' });
  expect(r.prevented).toBe(true);
  expect(r.value).toBe('');
  expect(r.chips).toHaveLength(1);
  expect(r.chips[0]).toMatch(/^pasted-image-\d+\.png$/);
});
test('html+image with filename text prefers the image', async ({ page }) => {
  const r = await paste(page, { image: 'cat.png', text: 'cat.png', html: '<img src="x.png">' });
  expect(r).toMatchObject({ prevented: true, value: '', chips: ['cat.png'] });
});
test('image URL text + <img> html prefers the image', async ({ page }) => {
  const r = await paste(page, { image: 'image.png', text: 'https://x.test/a.png', html: '<meta charset="utf-8"><img src="https://x.test/a.png">' });
  expect(r.value).toBe('');
  expect(r.chips).toHaveLength(1);
});
test('meaningful text + image pastes text and attaches the image', async ({ page }) => {
  const r = await paste(page, { image: 'shot.png', text: 'see the attached screenshot' });
  expect(r).toMatchObject({ prevented: false, value: 'see the attached screenshot', chips: ['shot.png'] });
});
test('empty paste does nothing and shows no toast', async ({ page }) => {
  const r = await paste(page, {});
  expect(r).toMatchObject({ prevented: false, value: '', chips: [] });
  await expect(page.locator('#toast')).toBeEmpty();
});
test('native fallback: outside Tauri it is null (success/fail/empty never throw)', async ({ page }) => {
  for (const mode of ['ok', 'fail', 'empty']) expect(await page.evaluate((m) => (window as any).__readNative(m), mode)).toBeNull();
});
