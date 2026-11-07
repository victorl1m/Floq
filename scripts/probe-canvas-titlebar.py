"""Canvas titlebar regression probe; all runtime traffic uses synthetic fixtures."""
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import Error, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.tmp/toolbar'

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

CANVAS = load('canvas_fixture', 'verify-final-canvas.py')
FIX = CANVAS.FIX

class Fixture(CANVAS.CanvasFixture):
    def __init__(self):
        super().__init__()
        self.notes = []

    def handle(self, route):
        path = urlparse(route.request.url).path
        if path == '/v1/projects/project-agi/notes':
            if route.request.method == 'POST':
                note = {**route.request.post_data_json, 'id': f'probe-note-{len(self.notes)}',
                        'projectId': 'project-agi', 'links': [],
                        'createdAt': '2026-01-01T00:00:00Z', 'updatedAt': '2026-01-01T00:00:00Z'}
                self.notes.append(note)
                body = note
            else:
                body = {'notes': self.notes}
            route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
            return
        super().handle(route)

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'syntheticRuntimeOnly': True, 'widths': [], 'assertions': {}}
    checks = report['assertions']
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 960})
        context.add_init_script("localStorage.setItem('theme','dark');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIX.USER) + "}));")
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        fixture = Fixture()
        page.route('**/*', fixture.handle)
        page.goto(os.environ.get('FLOQ_UI_URL', 'http://127.0.0.1:1421/'), wait_until='domcontentloaded')
        page.get_by_role('heading', name='Start a new task').wait_for()
        page.get_by_role('button', name='AGI Paulo - SARAH', exact=True).click()
        page.locator('.react-flow__node[data-id="agi-agent-2"]').wait_for()
        page.evaluate('document.fonts.ready')
        toolbar = page.locator('header [role="toolbar"][aria-label="Canvas toolbar"]')
        toolbar.wait_for()
        checks['titlebarOwner'] = toolbar.count() == 1
        checks['noFloatingToolbar'] = page.locator('.react-flow__panel [aria-label="Canvas tools"]').count() == 0
        wake = toolbar.locator('button[aria-label^="Wake all"], button[aria-label="No sleeping agents"]')
        count = sum(s['state'] == 'sleeping' and s['projectId'] == 'project-agi' for s in FIX.SESSIONS)
        checks['wakeAccessibleCount'] = str(count) in wake.get_attribute('aria-label') if count else wake.is_disabled()
        toolbar.get_by_role('button', name='Pan (drag to move canvas)', exact=True).click()
        page.keyboard.press('l')
        checks['shortcutFromPan'] = page.locator('[data-canvas-tool="link"]').count() == 1
        page.keyboard.press('Escape')
        checks['escapeFromTitlebar'] = page.locator('[data-canvas-tool="link"]').count() == 0
        toolbar.get_by_role('button', name='Fit view (F)', exact=True).click()
        before = page.locator('.react-flow__node-note').count()
        page.keyboard.press('n')
        page.wait_for_timeout(350)
        checks['noteShortcutFromFit'] = page.locator('.react-flow__node-note').count() == before + 1
        toolbar.click(button='right')
        checks['noCanvasContextMenu'] = page.get_by_role('menu').count() == 0
        for sidebar in (True, False):
            if not sidebar:
                page.get_by_role('button', name='Hide navigation', exact=True).click()
            for width in (1440, 1100, 900, 800):
                page.set_viewport_size({'width': width, 'height': 960})
                page.wait_for_timeout(300)
                sample = toolbar.evaluate("""e => {const visible=s=>!!e.querySelector(s)?.checkVisibility();return {width:e.clientWidth,scrollWidth:e.scrollWidth,headerHeight:e.closest('header').getBoundingClientRect().height,name:visible('.canvas-titlebar-name'),tools:visible('.canvas-titlebar-tools'),overflow:visible('.canvas-titlebar-overflow'),newLabel:visible('.canvas-titlebar-new-label')}}""")
                sample.update(viewport=width, sidebar=sidebar)
                report['widths'].append(sample)
        checks['widthsFit'] = all(s['scrollWidth'] <= s['width'] and s['headerHeight'] == 40 for s in report['widths'])
        checks['collapseOrder'] = all((s['name'] or s['width'] <= 639) and s['tools'] != s['overflow'] and (s['tools'] or not s['name']) and (s['newLabel'] or s['overflow']) for s in report['widths'])
        # Exercise the guaranteed minimum slot independently of sidebar geometry.
        toolbar.evaluate("e => {e.style.flex='none';e.style.width='280px'}")
        page.wait_for_timeout(100)
        checks['minimumSlotFits'] = toolbar.evaluate('e => e.scrollWidth <= e.clientWidth')
        checks['directActionsAtMinimum'] = toolbar.get_by_role('button', name='New agent', exact=True).is_visible() and toolbar.locator('button[aria-label^="Global vault"]').is_visible()
        overflow = toolbar.get_by_role('button', name='Canvas tools', exact=True)
        for key in ('Enter', 'Space', 'ArrowDown'):
            overflow.focus()
            page.keyboard.press(key)
            page.get_by_role('menu').wait_for()
            checks['overflowOpens' + key] = page.get_by_role('menu').is_visible()
            page.keyboard.press('Escape')
        overflow.click()
        page.get_by_role('menuitemcheckbox', name='Activity', exact=True).click()
        checks['overflowActivity'] = page.get_by_role('button', name='Close activity', exact=True).is_visible()
        toolbar.evaluate("e => {e.style.flex='';e.style.width=''}")
        page.set_viewport_size({'width': 1440, 'height': 960})
        page.wait_for_timeout(300)
        toolbar.get_by_role('button', name='Fit view (F)', exact=True).focus()
        page.keyboard.press('f')
        page.wait_for_timeout(500)
        bands = page.locator('.floor-band-label')
        checks['multiFloorFit'] = bands.count() >= 2 and all(b['y'] >= page.locator('.react-flow').bounding_box()['y'] for b in [bands.nth(i).bounding_box() for i in range(bands.count())])
        page.emulate_media(forced_colors='active')
        checks['forcedColorsPressed'] = toolbar.locator('[aria-pressed="true"]').first.evaluate("e => getComputedStyle(e).outlineStyle !== 'none'")
        page.emulate_media(forced_colors='none')
        page.screenshot(path=str(OUT / 'titlebar-dark.png'), animations='disabled')
        page.get_by_role('button', name='Show navigation', exact=True).click()
        page.get_by_role('button', name='Tasks', exact=True).click()
        checks['noToolbarOnTasks'] = toolbar.count() == 0
        page.get_by_role('button', name='Home', exact=True).click()
        checks['noToolbarOnHome'] = toolbar.count() == 0
        checks['noPageErrors'] = not errors
        report['pageErrors'] = errors
        browser.close()
    report['allPassed'] = all(checks.values())
    (OUT / 'probe-canvas-titlebar.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    if not report['allPassed']:
        raise SystemExit(1)

if __name__ == '__main__':
    try:
        main()
    except Error as error:
        # Keep a machine-readable failed result when this host cannot launch Chromium.
        # Exit nonzero; unavailable verification must never look like a passing probe.
        if not (OUT / 'probe-canvas-titlebar.json').exists():
            OUT.mkdir(parents=True, exist_ok=True)
            (OUT / 'probe-canvas-titlebar.json').write_text(json.dumps({
                'allPassed': False, 'status': 'unavailable', 'error': str(error),
            }, indent=2) + '\n')
        raise
