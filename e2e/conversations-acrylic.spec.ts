import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 420, height: 520 } });

const read = (page: import('@playwright/test').Page) => page.evaluate(() => [...document.querySelectorAll('h3.floq-sticky-head')].map((el) => {
  const c = getComputedStyle(el);
  const m = c.backgroundColor.match(/[\d.]+/g)!.map(Number);
  return { alpha: m.length > 3 ? m[3] : 1, blur: c.backdropFilter };
}));

// The real app sets data-material (glass|solid) always and data-native-material only when the shell applied an effect.
for (const theme of ['light', 'dark']) {
  for (const native of ['acrylic', '']) {
    test(`Conversations headers are translucent with blur (${theme}${native ? ', native acrylic' : ', no native material'})`, async ({ page }) => {
      await page.goto(`/e2e/harness/conversations-head.html?theme=${theme}${native ? `&native=${native}` : ''}`);
      const heads = await read(page);
      expect(heads.length).toBe(2);
      for (const h of heads) { expect(h.alpha).toBeLessThan(1); expect(h.blur).toContain('blur'); }
      if (native) { await page.waitForTimeout(200); await page.screenshot({ path: `.tmp/shots/conversations-acrylic-${theme}.png` }); }
    });
  }
}

test('Conversations headers stay opaque for the solid material preference', async ({ page }) => {
  await page.goto('/e2e/harness/conversations-head.html?material=solid&native=acrylic');
  for (const h of await read(page)) { expect(h.alpha).toBe(1); expect(h.blur).toBe('none'); }
});

test('Conversations headers stay opaque under reduced transparency', async ({ page }) => {
  // Playwright has no reducedTransparency option; drive the media feature through CDP.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await page.goto('/e2e/harness/conversations-head.html?native=acrylic');
  for (const h of await read(page)) { expect(h.alpha).toBe(1); expect(h.blur).toBe('none'); }
});
