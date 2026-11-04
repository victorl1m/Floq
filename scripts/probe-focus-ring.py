"""Tab-walk focus-visible audit: records ring/outline + radius per focused control. Needs vite on :1421."""
import importlib.util, json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "verify-ui.py")
F = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(F)
OUT = ROOT / "docs" / "redesign" / "button-states"
CONN = "localStorage.setItem('floq.connection', JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(F.USER) + "}));"
INFO = {"server": {"name": "floq-runtime", "version": "s", "startedAt": "2026-01-01T00:00:00Z", "providers": ["codex", "claude"], "maxSessions": 8, "activeSessions": 1}, "providers": [{"id": "claude", "label": "Claude", "command": "claude", "available": True, "version": "s", "args": [], "models": [{"id": "default", "label": "Default"}]}, {"id": "codex", "label": "Codex", "command": "codex", "available": True, "version": "s", "args": [], "models": []}], "githubConfigured": False}
ROLES = {"roles": [{"id": "r", "label": "Reviewer", "summary": "Reviews", "icon": "x", "capability": "high", "readOnly": True, "whenToUse": "x"}]}
JS = """()=>{const e=document.activeElement;if(!e||e===document.body)return null;const s=getComputedStyle(e);return {n:(e.getAttribute('aria-label')||e.textContent||e.id||e.tagName).trim().slice(0,24),fv:e.matches(':focus-visible'),shadow:s.boxShadow==='none'?'':s.boxShadow.slice(0,80),outline:s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0?s.outlineWidth+' '+s.outlineColor:'',r:s.borderRadius,border:s.borderColor}}"""
with sync_playwright() as p:
    b = p.chromium.launch()
    for mode in ("light", "dark", "solid"):
        ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
        ctx.add_init_script(f"localStorage.setItem('theme','{'dark' if mode == 'dark' else 'light'}');localStorage.setItem('floq.material','{'solid' if mode == 'solid' else 'glass'}');" + CONN)
        pg = ctx.new_page(); fx = F.Fixture()
        def h(route):
            from urllib.parse import urlparse
            path = urlparse(route.request.url).path; hd = {"access-control-allow-origin": "*"}
            if path == "/v1/info": route.fulfill(status=200, content_type="application/json", headers=hd, body=json.dumps(INFO))
            elif path == "/v1/agent-roles": route.fulfill(status=200, content_type="application/json", headers=hd, body=json.dumps(ROLES))
            else: fx.handle(route)
        pg.route("**/*", h)
        pg.goto("http://127.0.0.1:1421/", wait_until="domcontentloaded"); pg.wait_for_timeout(2200)
        pg.get_by_role("button", name="New agent").first.click(); pg.wait_for_timeout(900)
        for i in range(9):
            pg.keyboard.press("Tab"); pg.wait_for_timeout(250)
            info = pg.evaluate(JS); print(mode, i, info)
            if info and info["n"] in ("Default", "Generalist", "Cancel", "Claude Code"):
                pg.locator("[role=dialog]").screenshot(path=str(OUT / f"focus-{mode}-{info['n'].replace(' ', '')}.png"))
        ctx.close()
    b.close()
