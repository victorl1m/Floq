"""Drag & drop project folders in the sidebar against the synthetic fixture runtime (needs the dev server on :1421).

Usage: python scripts/verify-project-folders.py [dark|light] [glass|solid]
Writes screenshots to docs/redesign/ and prints a JSON report (order after every step + alignment measurements).
"""
import importlib.util, json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / file)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod
FIX = load("verify_ui", "verify-ui.py")
CANVAS = load("verify_canvas", "verify-final-canvas.py")
OUT = ROOT / "docs" / "redesign"; OUT.mkdir(parents=True, exist_ok=True)
THEME = sys.argv[1] if len(sys.argv) > 1 else "dark"
MAT = sys.argv[2] if len(sys.argv) > 2 else "glass"

STATE_JS = """()=>[...document.querySelectorAll('#app-navigation-sidebar [data-dnd-kind]')].map(e=>{
  const label=e.querySelector('[data-slot=sidebar-menu-button] span:last-of-type, input')?.textContent||e.querySelector('input')?.value||'';
  const r=e.getBoundingClientRect(); const nested=!!e.closest('ul[class*="border-l"]');
  return {kind:e.dataset.dndKind,id:e.dataset.dndId,nested,label:label.trim(),y:Math.round(r.y)}})"""

def order(page):
    return [("  " if r["nested"] else "") + r["kind"][0] + ":" + r["id"] for r in page.evaluate(STATE_JS)]

def center(page, kind, id_):
    b = page.locator(f'#app-navigation-sidebar [data-dnd-kind="{kind}"][data-dnd-id="{id_}"]').bounding_box()
    return b["x"] + b["width"] / 2 - 20, b["y"], b["height"]

def drag(page, kind, id_, tkind, tid, frac):
    sx, sy, sh = center(page, kind, id_); tx, ty, th = center(page, tkind, tid)
    page.mouse.move(sx, sy + sh / 2); page.mouse.down()
    page.mouse.move(sx, sy + sh / 2 + 8, steps=3)
    page.mouse.move(tx, ty + th * frac, steps=12)
    page.wait_for_timeout(120)

def measure(page):
    return page.evaluate("""()=>{
      const nav=document.querySelector('#app-navigation-sidebar'); const navR=nav.getBoundingClientRect(); const out=[];
      const rightOf=(el,sel)=>{const a=el.querySelector(sel); if(!a) return null; const r=a.getBoundingClientRect(); return {left:Math.round(r.left-navR.left),right:Math.round(navR.right-r.right),w:Math.round(r.width),h:Math.round(r.height)}};
      const row=(label,el,btnSel)=>{ const r=el.getBoundingClientRect(); const icon=el.querySelector(btnSel+' svg, '+btnSel+' img'); const ir=icon?.getBoundingClientRect();
        const span=[...el.querySelectorAll(btnSel+' span')].find(s=>s.textContent.trim()); const sr=span?.getBoundingClientRect();
        out.push({row:label,height:Math.round(r.height),iconX:ir?Math.round(ir.left-navR.left):null,iconIsImg:icon?.tagName==='IMG',labelX:sr?Math.round(sr.left-navR.left):null,
          secondSlot:rightOf(el,'[data-row-action=second]'),chevronSlot:rightOf(el,'[data-row-action=chevron]'),thirdSlot:rightOf(el,'[data-row-action=third]'),
          count:(()=>{const c=[...el.querySelectorAll('span[aria-hidden=true]')].find(x=>/^[0-9]+$/.test(x.textContent));if(!c)return null;const q=c.getBoundingClientRect();return {left:Math.round(q.left-navR.left),w:Math.round(q.width)}})()}) };
      for(const e of nav.querySelectorAll('[data-dnd-kind]')){
        const nested=!!e.closest('ul[class*="border-l"]');
        row((e.dataset.dndKind==='folder'?'folder':nested?'project(in folder)':'project(root)')+' '+(e.querySelector('button')?.textContent||'').trim().slice(0,18),e,'button');
      }
      [...nav.querySelectorAll('[class*="group/workspace-row"]')].slice(0,3).forEach(w=>row('workspace '+w.textContent.trim().slice(0,16),w,'button'));
      [...nav.querySelectorAll('[class*="group/agent-row"]')].slice(0,2).forEach(a=>row('agent '+a.textContent.trim().slice(0,16),a,'button'));
      return out}""")

IMG = "data:image/svg+xml;utf8," + "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3' fill='%23e8590c'/><text x='8' y='12' font-size='10' text-anchor='middle' fill='white'>A</text></svg>".replace("#", "%23")

class ImageFixture(CANVAS.CanvasFixture):
    def handle(self, route):
        from urllib.parse import urlparse
        if urlparse(route.request.url).path == "/v1/projects":
            projects = json.loads(json.dumps(FIX.PROJECTS))
            for pr in projects:
                if pr["id"] in ("project-api", "project-agi"): pr["imageUrl"] = IMG
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"projects": projects})); return
        super().handle(route)

def main():
    report = {"theme": THEME, "material": MAT, "steps": {}, "checks": {}}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1300})
        context.add_init_script("if(!sessionStorage.getItem('seeded')){localStorage.setItem('theme','" + THEME + "');localStorage.setItem('floq.material','" + MAT + "');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIX.USER) + "}));sessionStorage.setItem('seeded','1')}")
        page = context.new_page(); errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route("**/*", ImageFixture().handle)
        page.goto("http://127.0.0.1:1421/", wait_until="domcontentloaded", timeout=15000)
        page.get_by_role("heading", name="Start a new task").wait_for(timeout=10000)
        nav = page.locator("#app-navigation-sidebar")
        import atexit; atexit.register(lambda: print(json.dumps(report, indent=1)))
        nav.locator('[data-dnd-kind="project"]').first.wait_for(timeout=8000)
        report["steps"]["0-initial"] = order(page)

        # create folder (inline rename)
        nav.get_by_role("button", name="New folder").click()
        inp = nav.get_by_label("Folder name"); inp.wait_for(timeout=3000); inp.fill("Clients"); inp.press("Enter")
        page.wait_for_timeout(200)
        report["steps"]["1-folder-created"] = order(page)
        folder_id = page.locator('#app-navigation-sidebar [data-dnd-kind="folder"]').first.get_attribute("data-dnd-id")

        # drag project-api into folder, then project-flowless
        drag(page, "project", "project-api", "folder", folder_id, 0.5)
        report["checks"]["folderHighlightWhileDragging"] = page.locator('[data-dnd-drop="into"]').count() == 1
        page.screenshot(path=str(OUT / f"folders-dragging-{MAT}-{THEME}.png"), animations="disabled")
        page.mouse.up(); page.wait_for_timeout(250)
        report["steps"]["2-api-in-folder"] = order(page)
        drag(page, "project", "project-flowless", "folder", folder_id, 0.5); page.mouse.up(); page.wait_for_timeout(250)
        report["steps"]["3-flowless-in-folder"] = order(page)

        # reorder within folder: flowless before api
        drag(page, "project", "project-api", "project", "project-flowless", 0.15)
        report["checks"]["insertionLineWhileDragging"] = page.locator('[data-dnd-drop="before"]').count() == 1
        page.mouse.up(); page.wait_for_timeout(250)
        report["steps"]["4-reordered"] = order(page)

        # ungroup: drop flowless on the root project demo (before)
        drag(page, "project", "project-flowless", "project", "project-agi", 0.15); page.mouse.up(); page.wait_for_timeout(250)
        report["steps"]["5-ungrouped"] = order(page)
        report["alignment"] = measure(page)
        page.screenshot(path=str(OUT / f"folders-aligned-{MAT}-{THEME}.png"), animations="disabled")
        nav.screenshot(path=str(OUT / f"folders-sidebar-{MAT}-{THEME}.png"), animations="disabled")
        row0 = nav.locator('[data-dnd-kind="project"][data-dnd-id="project-flowless"]'); row0.hover(); page.wait_for_timeout(250)
        nav.screenshot(path=str(OUT / f"folders-sidebar-hover-{MAT}-{THEME}.png"), animations="disabled")

        # keyboard: focus project-agi button, Space, ArrowDown to folder header (into), Space
        btn = page.locator('#app-navigation-sidebar [data-dnd-kind="project"][data-dnd-id="project-agi"] [data-slot=sidebar-menu-button]')
        btn.focus(); page.keyboard.press("Space"); page.wait_for_timeout(150)
        for _ in range(8):
            if page.locator('[data-dnd-drop="into"]').count(): break
            page.keyboard.press("ArrowDown"); page.wait_for_timeout(120)
        report["checks"]["keyboardIntoHint"] = page.locator('[data-dnd-drop="into"]').count() == 1
        live = page.locator('[role=status]').all_inner_texts(); report["checks"]["liveRegion"] = [t for t in live if t][:3]
        page.keyboard.press("Space"); page.wait_for_timeout(250)
        report["steps"]["6-keyboard-agi-in-folder"] = order(page)
        report["checks"]["keyboardDidNotOpenCanvas"] = "canvas" not in (page.evaluate("location.hash+location.pathname"))

        # context-menu alternative
        proj = page.locator('#app-navigation-sidebar [data-dnd-kind="project"][data-dnd-id="project-flowless"]')
        proj.click(button="right"); page.get_by_role("menuitem", name="Move to folder").click()
        page.get_by_role("menuitem", name="Clients").click(); page.wait_for_timeout(250)
        report["steps"]["7-menu-demo-in-folder"] = order(page)

        # persistence
        before = order(page); page.reload(wait_until="domcontentloaded")
        nav.locator('[data-dnd-kind="project"]').first.wait_for(timeout=10000); page.wait_for_timeout(300)
        report["steps"]["8-after-reload"] = order(page)
        report["checks"]["persistedAfterReload"] = before == order(page)

        # collapse + count

        # delete folder with undo
        nav.locator('[data-dnd-kind="folder"]').first.click(button="right"); page.get_by_role("menuitem", name="Delete folder (keep projects)").click(); page.wait_for_timeout(250)
        report["steps"]["9-folder-deleted"] = order(page)
        page.get_by_role("button", name="Undo").click(); page.wait_for_timeout(300)
        report["steps"]["10-undo"] = order(page)
        report["errors"] = errors
        context.close(); browser.close()

if __name__ == "__main__":
    main()
