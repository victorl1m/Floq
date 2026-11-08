"""Button state matrix: idle/hover/pressed per visible button across scenes x (light, dark, solid) with the OS scheme forced
dark. Needs vite/preview on :1421.
Usage: python scripts/dev/probe-button-states.py [tag]  -> docs/redesign/button-states/{tag}-report.json + screenshots."""
import os
import importlib.util, json, sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "dev" / "verify-ui.py")
F = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(F)
OUT = ROOT / "docs" / "redesign" / "button-states"; OUT.mkdir(parents=True, exist_ok=True)
tag = sys.argv[1] if len(sys.argv) > 1 else "after"
CONN = "localStorage.setItem('floq.connection', JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(F.USER) + "}));"
INFO = {"server": {"name": "floq-runtime", "version": "s", "startedAt": "2026-01-01T00:00:00Z", "providers": ["codex", "claude"], "maxSessions": 8, "activeSessions": 1},
        "providers": [{"id": "claude", "label": "Claude", "command": "claude", "available": True, "version": "s", "args": [], "models": [{"id": "default", "label": "Default"}, {"id": "sonnet", "label": "Sonnet"}]},
                      {"id": "codex", "label": "Codex", "command": "codex", "available": True, "version": "s", "args": [], "models": []}], "githubConfigured": False}
ROLES = {"roles": [{"id": "r", "label": "Reviewer", "summary": "Reviews", "icon": "x", "capability": "high", "readOnly": True, "whenToUse": "x"}]}
JS = r"""(sel)=>{
 const cv=document.createElement('canvas').getContext('2d');
 const rgba=c=>{cv.clearRect(0,0,1,1);cv.fillStyle='rgba(0,0,0,0)';cv.fillStyle=c;cv.fillRect(0,0,1,1);const d=cv.getImageData(0,0,1,1).data;return [d[0],d[1],d[2],d[3]/255]};
 const over=(t,b)=>{const a=t[3];return [0,1,2].map(i=>t[i]*a+b[i]*(1-a)).concat([1])};
 const lum=c=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(c[0])+.7152*f(c[1])+.0722*f(c[2])};
 const bgOf=e=>{let layers=[];for(let n=e;n;n=n.parentElement){const c=rgba(getComputedStyle(n).backgroundColor);if(c[3]>0)layers.push(c);if(c[3]>=1)break}
  let base=document.documentElement.classList.contains('dark')?[10,10,10,1]:[255,255,255,1];let r=base;for(let i=layers.length-1;i>=0;i--)r=over(layers[i],r);return r};
 const e=document.querySelector(sel); if(!e) return null; const s=getComputedStyle(e); const bg=bgOf(e); const fgc=over(rgba(s.color),bg);
 const L1=lum(fgc),L2=lum(bg); const contrast=(Math.max(L1,L2)+.05)/(Math.min(L1,L2)+.05);
 const r=e.getBoundingClientRect();
 return {bg:bg.map(Math.round),lum:+L2.toFixed(3),contrast:+contrast.toFixed(2),cursor:s.cursor,bf:s.backdropFilter,w:Math.round(r.width),h:Math.round(r.height),ring:(s.boxShadow!=='none'?s.boxShadow.slice(0,90):'')+(s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0?' outline '+s.outlineWidth:''),radius:s.borderRadius,dis:!!(e.disabled||e.getAttribute('aria-disabled')==='true')}}"""
MARK = r"""()=>{let i=0;const out=[];for(const e of document.querySelectorAll('button,[role=button],[role=tab],[role=menuitem],[role=radio],[role=switch],[role=checkbox],[role=option],[role=combobox],[cmdk-item],[role=menuitemradio],[role=menuitemcheckbox]')){const r=e.getBoundingClientRect();const s=getComputedStyle(e);
 if(r.width<8||r.height<8||s.visibility==='hidden'||s.display==='none'||e.closest('[aria-hidden=true],[inert]'))continue;if(r.bottom<0||r.top>innerHeight||r.right<0||r.left>innerWidth)continue;
 e.setAttribute('data-probe-id',String(i));out.push({id:i,name:(e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,28),cls:(e.dataset.slot||'')+'/'+(e.dataset.variant||e.dataset.floqVariant||'')+'/'+(e.dataset.size||'')});i++}return out}"""


def scene_open(pg, scene):
    if scene == "dialog": pg.get_by_role("button", name="New agent").first.click()
    elif scene.startswith("settings"):
        pg.keyboard.press("Control+,"); pg.wait_for_timeout(900)
        if scene != "settings":
            nav = pg.locator("[role=dialog] button[aria-current], [role=dialog] nav button").all()
            want = scene.split(":")[1]
            pg.locator("[role=dialog]").get_by_text(want, exact=True).first.click(); pg.wait_for_timeout(700)
    elif scene == "palette": pg.keyboard.press("Control+k")
    elif scene == "menu": pg.get_by_role("button", name="Actions for AGI Paulo - SARAH").first.click(force=True)
    elif scene == "ctx": pg.get_by_text("AGI Paulo - SARAH").first.click(button="right")
    elif scene == "picker": pg.get_by_role("button", name="Model").first.click()
    elif scene == "secrets":
        pg.get_by_text("Secrets").first.click(timeout=4000); pg.wait_for_timeout(700)
        if pg.get_by_text("Keychains").count(): pg.get_by_text("Keychains").first.click()
    elif scene == "clone": pg.get_by_role("button", name="New project").first.click()
    pg.wait_for_timeout(900)


SCENES = ("home", "dialog", "clone", "settings", "secrets", "palette", "menu", "ctx", "picker")
report = {}
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    for mode in ("light", "dark", "solid"):
        for scene in SCENES:
            ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
            th = "dark" if mode == "dark" else "light"
            ctx.add_init_script(f"localStorage.setItem('theme','{th}');localStorage.setItem('floq.material','{'solid' if mode == 'solid' else 'mica'}');" + CONN)
            pg = ctx.new_page(); fx = F.Fixture()

            def h(route):
                path = urlparse(route.request.url).path
                hd = {"access-control-allow-origin": "*"}
                if path == "/v1/info": route.fulfill(status=200, content_type="application/json", headers=hd, body=json.dumps(INFO))
                elif path == "/v1/agent-roles": route.fulfill(status=200, content_type="application/json", headers=hd, body=json.dumps(ROLES))
                else: fx.handle(route)
            pg.route("**/*", h)
            pg.goto(os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421/"), wait_until="domcontentloaded"); pg.wait_for_timeout(2200)
            key = f"{mode}-{scene}"
            try:
                scene_open(pg, scene)
                pg.screenshot(path=str(OUT / f"{tag}-{key}.png"), animations="disabled")
                items = pg.evaluate(MARK); rows = []
                seen = {}; picked = []
                for it in items:
                    k2 = it['cls'] + ('/' + it['name'] if it['cls'].startswith(('/','menuitem')) is False and False else ''); seen[k2] = seen.get(k2, 0) + 1
                    if seen[k2] <= 3: picked.append(it)
                for it in picked[:24]:
                    sel = f"[data-probe-id='{it['id']}']"; loc = pg.locator(sel)
                    pg.mouse.move(0, 0); pg.mouse.up(); pg.wait_for_timeout(420)
                    idle = pg.evaluate(JS, sel)
                    if not idle: continue
                    try: loc.hover(timeout=800, force=True)
                    except Exception: continue
                    pg.wait_for_timeout(420); hov = pg.evaluate(JS, sel)
                    pg.mouse.down(); pg.wait_for_timeout(300); prs = pg.evaluate(JS, sel)
                    pg.mouse.up(); pg.mouse.move(0, 0); pg.wait_for_timeout(100)
                    foc = None
                    if not idle["dis"]:
                        try:
                            pg.keyboard.press("Shift"); pg.evaluate("(s)=>document.querySelector(s).focus({focusVisible:true})", sel); pg.wait_for_timeout(350)
                            foc = pg.evaluate(JS, sel); pg.evaluate("(s)=>document.querySelector(s).blur()", sel)
                        except Exception: pass
                    flags = []
                    if hov and idle:
                        d = abs(hov["lum"] - idle["lum"]); same = idle["bg"] == hov["bg"]
                        if not idle["dis"] and same and "link" not in it["cls"] and "tabs" not in it["cls"]: flags.append("no-hover-change")
                        if not idle["dis"] and not same and d < 0.008 and max(abs(a - b) for a, b in zip(idle["bg"], hov["bg"])) < 3: flags.append("hover-invisible")
                        if d > 0.12: flags.append(f"hover-jump {d:.2f}")
                        if mode != "dark" and 0.18 < hov["lum"] < 0.6 and hov["bg"] != idle["bg"] and "filled" not in it["cls"] and "default/default" not in it["cls"]: flags.append("mid-grey-hover")
                        if idle["dis"] and idle["bg"] != hov["bg"]: flags.append("disabled-reacts")
                        if (hov["w"], hov["h"]) != (idle["w"], idle["h"]): flags.append("layout-shift")
                        if not idle["dis"] and hov["cursor"] not in ("pointer", "text", "default", "grab"): flags.append("cursor " + hov["cursor"])
                        if not idle["dis"]:
                            c = min(idle["contrast"], hov["contrast"], (prs or hov)["contrast"], (foc or hov)["contrast"])
                            if c < 4.5: flags.append(f"contrast {c:.1f}")
                        if foc and not foc["ring"]: flags.append("no-focus-ring")
                    rows.append({**it, "idle": idle, "hover": hov, "pressed": prs, "focus": foc, "flags": flags})
                report[key] = rows
            except Exception as ex:
                report[key] = {"error": str(ex)[:200]}
            ctx.close()
    b.close()
(OUT / f"{tag}-report.json").write_text(json.dumps(report, indent=1))
for k, rows in report.items():
    if isinstance(rows, dict): print(k, rows); continue
    bad = [r for r in rows if r["flags"]]
    print(f"{k}: {len(rows)} buttons, {len(bad)} flagged")
    for r in bad: print("   ", r["name"], r["cls"], r["flags"], "idle", r["idle"]["bg"], "hov", r["hover"]["bg"])
