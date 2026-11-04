"""Focused production probe for the Home hero reveal in light and reduced motion."""
import os
import importlib.util
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "verify-ui.py")
FIXTURES = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(FIXTURES)
OUT = ROOT / "docs" / "redesign"
OUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    reports = {}
    for mode in ("no-preference", "reduce"):
        context = browser.new_context(viewport={"width": 1440, "height": 960})
        context.add_init_script("localStorage.setItem('theme','light'); localStorage.setItem('floq.connection', JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIXTURES.USER) + "}));")
        page = context.new_page()
        page.emulate_media(reduced_motion=mode)
        fixture = FIXTURES.Fixture()
        page.route("**/*", fixture.handle)
        page.goto(os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421/"), wait_until="domcontentloaded", timeout=15000)
        page.get_by_role("heading", name="Start a new task").wait_for(timeout=10000)
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(5000)
        reports[mode] = page.evaluate("""() => {
          const h=document.querySelector('h1'), w=h?.closest('[data-home-reveal]'), p=w?.parentElement;
          const cs=e=>e&&({display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility,opacity:getComputedStyle(e).opacity,color:getComputedStyle(e).color,transform:getComputedStyle(e).transform,animation:getComputedStyle(e).animationName,rect:(()=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})(),text:e.innerText,ariaHidden:e.getAttribute('aria-hidden'),role:e.getAttribute('role'),className:typeof e.className==='string'?e.className:null,attrs:[...e.attributes].map(a=>[a.name,a.value])});
          return {theme:document.documentElement.className,material:document.documentElement.dataset.material,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,heading:cs(h),revealWrapper:cs(w),parent:cs(p),textPresent:document.body.innerText.includes('Choose a project and tell your agent what to build.')};
        }""")
        page.screenshot(path=str(OUT / f"home-light-verified-{mode}.png"), full_page=True, animations="disabled")
        ax = page.context.new_cdp_session(page).send("Accessibility.getFullAXTree").get("nodes", [])
        reports[mode]["axHeading"] = [{"role":n.get("role",{}).get("value"),"name":n.get("name",{}).get("value"),"ignored":n.get("ignored")} for n in ax if n.get("name",{}).get("value")=="Start a new task"]
        context.close()
    browser.close()
print(json.dumps(reports, indent=2))
(OUT / "home-light-reveal-probe.json").write_text(json.dumps(reports, indent=2), encoding="utf-8")
