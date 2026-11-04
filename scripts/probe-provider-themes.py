"""Provider theme probe: home composer, sidebar rows, canvas cards and New agent dialog in light/dark."""
import os
import importlib.util, json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "verify-ui.py")
FIX = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(FIX)
OUT = ROOT / "docs" / "redesign" / "provider-themes"; OUT.mkdir(parents=True, exist_ok=True)
rep = {}
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    for theme in ("light", "dark"):
        ctx = b.new_context(viewport={"width": 1440, "height": 960})
        ctx.add_init_script(f"localStorage.setItem('theme','{theme}');localStorage.setItem('floq.connection',JSON.stringify({{baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:{json.dumps(FIX.USER)}}}));")
        page = ctx.new_page(); page.route("**/*", FIX.Fixture().handle)
        page.goto(os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421/"), wait_until="domcontentloaded")
        page.get_by_role("heading", name="Start a new task").wait_for(timeout=10000); page.wait_for_timeout(1500)
        page.screenshot(path=str(OUT / f"{theme}-sidebar-rows.png"))
        rep[theme] = page.evaluate("""()=>[...document.querySelectorAll('svg[data-provider]')].slice(0,6).map(e=>[e.dataset.provider,getComputedStyle(e).color])""")
        page.screenshot(path=str(OUT / f"{theme}-home.png"))
        rep[theme+"-start"] = page.evaluate("""()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Start agent'));const s=getComputedStyle(b);return [b.dataset.provider,s.backgroundColor,s.color]}""")
        page.locator('[data-slot="sidebar-menu-button"]').filter(has_text="AGI Paulo").first.click(); page.wait_for_timeout(1500)
        node = page.locator(".react-flow__node").first
        if node.count(): node.click(position={"x": 30, "y": 60}); page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / f"{theme}-canvas.png"))
        rep[theme+"-nodes"] = page.evaluate("""()=>[...document.querySelectorAll('.react-flow__node [data-provider]')].map(e=>{const c=e.querySelector('.canvas-agent-card-material');return [e.dataset.provider,c&&getComputedStyle(c).borderColor]})""")
        btn = page.get_by_role("button", name="New agent").first
        if btn.count():
            btn.click(); page.wait_for_timeout(600); page.screenshot(path=str(OUT / f"{theme}-new-agent.png"))
            rep[theme+"-radios"] = page.evaluate("""()=>[...document.querySelectorAll('[role=radio]')].map(e=>[e.dataset.provider,e.getAttribute('aria-checked'),getComputedStyle(e).borderColor,getComputedStyle(e).backgroundColor])""")
        ctx.close()
    b.close()
print(json.dumps(rep, indent=1))
