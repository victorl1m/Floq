"""Before/after of the Glisse OS-scheme leak on the Keychains empty-state button. Needs vite on :1421."""
import os
import importlib.util, json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "verify-ui.py")
F = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(F)
OUT = ROOT / "docs" / "redesign" / "button-states"; OUT.mkdir(parents=True, exist_ok=True)
CONN = "localStorage.setItem('floq.connection', JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(F.USER) + "}));"
LEAK = "document.documentElement.removeAttribute('data-theme');document.documentElement.style.setProperty('--lg-glass-active','#4646469e');document.documentElement.style.setProperty('--lg-lens','#ffffff0e');"
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    for mode in ("light", "dark", "solid"):
        for variant in ("before", "after"):
            ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
            ctx.add_init_script(f"localStorage.setItem('theme','{'dark' if mode == 'dark' else 'light'}');localStorage.setItem('floq.material','{'solid' if mode == 'solid' else 'glass'}');" + CONN)
            pg = ctx.new_page(); fx = F.Fixture(); pg.route("**/*", lambda r: fx.handle(r))
            pg.goto(os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421/"), wait_until="domcontentloaded"); pg.wait_for_timeout(2200)
            pg.get_by_text("Secrets").first.click(); pg.wait_for_timeout(1200)
            if variant == "before": pg.evaluate("()=>{" + LEAK + "}")
            btn = pg.get_by_role("button", name="Open canvas to create one")
            box = btn.bounding_box(); clip = {"x": box["x"] - 40, "y": box["y"] - 30, "width": box["width"] + 80, "height": box["height"] + 60}
            for st in ("idle", "hover", "pressed"):
                pg.mouse.move(0, 0); pg.mouse.up()
                if st != "idle": btn.hover(force=True)
                if st == "pressed": pg.mouse.down()
                pg.wait_for_timeout(300)
                pg.screenshot(path=str(OUT / f"keychains-{variant}-{mode}-{st}.png"), clip=clip)
                print(mode, variant, st, pg.evaluate("(e)=>getComputedStyle(document.querySelector(e)).backgroundColor", "button[data-floq-variant=outline]"))
            ctx.close()
    b.close()
