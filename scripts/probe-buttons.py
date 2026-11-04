"""Button migration probe: login/home/settings in light+dark with hover/focus states. Needs preview on :1421."""
import os
import importlib.util, json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "verify-ui.py")
F = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(F)
OUT = ROOT / "docs" / "redesign" / "buttons"; OUT.mkdir(parents=True, exist_ok=True)
CONN = "localStorage.setItem('floq.connection', JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(F.USER) + "}));"
report = {}
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    for theme in ("light", "dark"):
        for scene in ("login", "home", "settings"):
            ctx = b.new_context(viewport={"width": 1440, "height": 900})
            ctx.add_init_script(f"localStorage.setItem('theme','{theme}');" + ("" if scene == "login" else CONN))
            pg = ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.route("**/*", F.Fixture().handle)
            pg.goto(os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421/"), wait_until="domcontentloaded"); pg.wait_for_timeout(2500)
            if scene == "settings":
                try: pg.get_by_role("button", name="Settings").first.click(timeout=3000); pg.wait_for_timeout(800)
                except Exception as e: errs.append("settings-open: " + str(e)[:80])
            pg.screenshot(path=str(OUT / f"{scene}-{theme}.png"), animations="disabled")
            info = pg.evaluate("""() => [...document.querySelectorAll('[data-slot=button]')].slice(0,60).map(b=>{const c=getComputedStyle(b);return {v:b.dataset.variant||b.dataset.floqVariant,glisse:b.classList.contains('lg-button'),h:b.offsetHeight,r:c.borderTopLeftRadius,bf:c.backdropFilter,dis:b.disabled}})""")
            # hover + keyboard focus on first glisse button
            btn = pg.locator("button.lg-button:not(:disabled)").first
            if btn.count():
                btn.hover(); pg.wait_for_timeout(300); pg.screenshot(path=str(OUT / f"{scene}-{theme}-hover.png"), clip=btn.bounding_box() and {"x":max(btn.bounding_box()["x"]-20,0),"y":max(btn.bounding_box()["y"]-20,0),"width":btn.bounding_box()["width"]+40,"height":btn.bounding_box()["height"]+40})
                pg.mouse.move(0,0); pg.keyboard.press("Tab")
                pg.screenshot(path=str(OUT / f"{scene}-{theme}-focus.png"))
            report[f"{scene}-{theme}"] = {"count": len(info), "glisse": sum(i["glisse"] for i in info), "withBackdrop": sum(1 for i in info if i["bf"] not in ("none","")), "errors": errs, "sample": info[:6]}
            ctx.close()
    b.close()
(OUT / "report.json").write_text(json.dumps(report, indent=2))
print(json.dumps({k:{kk:vv for kk,vv in v.items() if kk!="sample"} for k,v in report.items()}, indent=1))
