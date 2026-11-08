"""Browser smoke for native-material preference and transparency fallbacks."""
import os
import importlib.util
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "dev" / "verify-ui.py")
FIXTURES = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(FIXTURES)
OUT = ROOT / "docs" / "redesign"
OUT.mkdir(parents=True, exist_ok=True)

cases = [("solid", False, False), ("mica", True, False), ("mica", False, False), ("mica", False, True)]
results = {}
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for material, reduce, forced in cases:
        context = browser.new_context(viewport={"width": 1440, "height": 960})
        context.add_init_script("localStorage.setItem('theme','dark'); localStorage.setItem('floq.material'," + json.dumps(material) + "); localStorage.setItem('floq.connection', JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIXTURES.USER) + "}));")
        page = context.new_page()
        if reduce:
            page.context.new_cdp_session(page).send("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-reduced-transparency", "value": "reduce"}]})
        if forced:
            page.context.new_cdp_session(page).send("Emulation.setEmulatedMedia", {"features": [{"name": "forced-colors", "value": "active"}]})
        fixture = FIXTURES.Fixture()
        page.route("**/*", fixture.handle)
        page.goto(os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421/"), wait_until="domcontentloaded", timeout=15000)
        page.get_by_role("heading", name="Start a new task").wait_for(timeout=10000)
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(700)
        result = page.evaluate("""() => {const q=document.querySelector('.sidebar-search-glass'),qs=q&&getComputedStyle(q);const activeFilters=[...document.querySelectorAll('*')].map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {tag:e.tagName,slot:e.getAttribute('data-slot'),className:typeof e.className==='string'?e.className:'',filter:s.backdropFilter,area:Math.round(r.width*r.height)}}).filter(x=>x.area>0&&x.filter!=='none');return {material:document.documentElement.dataset.material,reducedTransparency:matchMedia('(prefers-reduced-transparency: reduce)').matches,searchFilter:qs?.backdropFilter||null,activeFilters,heroOpacity:getComputedStyle(document.querySelector('h1')).opacity}}""")
        no_transparency = (material == "solid" or reduce or forced)
        result["assets"] = page.evaluate("performance.getEntriesByType('resource').map(e=>e.name.split('/').pop()).filter(n=>/^index-.*\\.(js|css)$/.test(n))")
        result["mode"] = {"material": material, "reduced": reduce, "forcedColors": forced}
        result["expectedNoTransparencyHooks"] = no_transparency and result["searchFilter"] in (None, "none") and len(result["activeFilters"]) == 0
        result["fallbackPass"] = result["expectedNoTransparencyHooks"] if no_transparency else result["searchFilter"] not in (None, "none") and len(result["activeFilters"]) > 0
        results[f"{material}-{'forced-colors' if forced else 'reduce' if reduce else 'native'}"] = result
        page.screenshot(path=str(OUT / f"material-{material}-{'forced-colors' if forced else 'reduced' if reduce else 'current'}-production.png"), full_page=True, animations="disabled")
        context.close()
    browser.close()
print(json.dumps(results, indent=2))
(OUT / "material-fallbacks-production.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
if not all(value.get("fallbackPass") for value in results.values()):
    raise SystemExit(1)
