"""Five-second production Home frame smoke; headless browser only, synthetic REST only."""
import importlib.util, json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "verify-ui.py")
FIXTURES = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(FIXTURES)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 960})
    context.add_init_script("localStorage.setItem('theme','dark'); localStorage.setItem('floq.material','glass'); localStorage.setItem('floq.connection', JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIXTURES.USER) + "}));")
    page = context.new_page()
    page.route("**/*", FIXTURES.Fixture().handle)
    page.goto("http://127.0.0.1:1421/", wait_until="domcontentloaded", timeout=15000)
    page.get_by_role("heading", name="Start a new task").wait_for(timeout=10000)
    page.evaluate("document.fonts.ready")
    sample = page.evaluate("""async () => {const a=[];await new Promise(done=>{let prev;const start=performance.now();function tick(t){if(prev!==undefined)a.push(t-prev);prev=t;if(t-start<5000)requestAnimationFrame(tick);else done()}requestAnimationFrame(tick)});const s=a.slice().sort((x,y)=>x-y);const q=p=>s[Math.min(s.length-1,Math.floor(s.length*p))]??null;return {durationMs:5000,frames:a.length,p50Ms:q(.5),p95Ms:q(.95),over32ms:a.filter(x=>x>32).length,over50ms:a.filter(x=>x>50).length,assets:performance.getEntriesByType('resource').map(x=>x.name).filter(x=>x.includes('/assets/index-')&&x.endsWith('.js'))}}""")
    page.screenshot(path=str(ROOT / "docs" / "redesign" / "home-final-bundle-smoke.png"), full_page=True, animations="disabled")
    browser.close()
print(json.dumps(sample, indent=2))
(ROOT / "docs" / "redesign" / "ui-final-bundle-5s-smoke.json").write_text(json.dumps(sample, indent=2), encoding="utf-8")
