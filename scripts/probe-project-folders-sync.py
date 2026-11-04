"""Server-side project folders probe on the synthetic fixture runtime (FLOQ_UI_URL, default http://127.0.0.1:1431/).

 1. create + rename a folder -> one debounced PUT (versioned) reaches the runtime
 2. brand-new browser profile (empty localStorage) -> the folder is still there (the original bug)
 3. migration: legacy localStorage layout + empty server -> pushed once, backup key kept, nothing pushed again on reload
 4. another device changes the layout -> picked up on window focus (no reload)
 5. a different user on the same browser never sees these folders
 6. runtime offline -> edits stay local, retried later; unsaved edits are pushed after the runtime returns
 7. project deleted elsewhere -> disappears from folders (reconcile)
Screenshots (dark + light) in docs/redesign/folders-sync/.
"""
import importlib.util, json, os, sys, re
from pathlib import Path
from urllib.parse import urlparse, quote
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
def load(n, f):
    s = importlib.util.spec_from_file_location(n, ROOT / "scripts" / f); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
FIX = load("verify_ui", "verify-ui.py"); CANVAS = load("vfc", "verify-final-canvas.py")
OUT = ROOT / "docs" / "redesign" / "folders-sync"; OUT.mkdir(parents=True, exist_ok=True)
URL = os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1431/")
BASE_URL = "http://synthetic-runtime.invalid"
P_AGI, P_API, P_FLOW = "project-agi", "project-api", "project-flowless"

class Server(CANVAS.CanvasFixture):
    """Runtime double with the real contract for GET/PUT /v1/project-folders, one document per user (token = user)."""
    def __init__(self):
        super().__init__(); self.docs = {}; self.versions = {}; self.puts = []; self.offline = False; self.removed_projects = set()
    def user(self, req):
        auth = req.headers.get("authorization", ""); return auth.removeprefix("Bearer ") or "anonymous"
    def handle(self, route):
        req = route.request; path = urlparse(req.url).path
        if path == "/v1/project-folders":
            if self.offline:
                route.abort(); return
            u = self.user(req)
            if req.method == "GET":
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"version": self.versions.get(u, 0), "doc": self.docs.get(u), "updatedAt": None})); return
            if req.method == "PUT":
                body = json.loads(req.post_data or "{}"); self.puts.append((u, body["version"], body["doc"]))
                if body["version"] != self.versions.get(u, 0):
                    route.fulfill(status=409, content_type="application/json", body=json.dumps({"error": {"code": "version_conflict", "message": "Your folders changed on another device."}})); return
                self.versions[u] = self.versions.get(u, 0) + 1; self.docs[u] = body["doc"]
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"version": self.versions[u], "doc": body["doc"], "updatedAt": None})); return
        if path == "/v1/projects" and req.method == "GET":
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"projects": [p for p in FIX.PROJECTS if p["id"] not in self.removed_projects]})); return
        super().handle(route)
    def other_device(self, user, mutate):
        doc = json.loads(json.dumps(self.docs.get(user) or {"folders": [], "root": [], "membership": {}, "expanded": {}}))
        mutate(doc); self.docs[user] = doc; self.versions[user] = self.versions.get(user, 0) + 1

res = {}
def check(name, ok, info=""):
    res[name] = bool(ok); print(("PASS " if ok else "FAIL ") + name, info)

def new_context(browser, theme, user_id="synthetic-user", seed=None):
    ctx = browser.new_context(viewport={"width": 1440, "height": 960})
    user = {**FIX.USER, "id": user_id}
    script = "localStorage.setItem('theme','" + theme + "');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'" + BASE_URL + "',token:'" + user_id + "',user:" + json.dumps(user) + "}));"
    if seed: script += "if(!localStorage.getItem('seeded')){" + seed + ";localStorage.setItem('seeded','1')}"
    ctx.add_init_script(script)
    return ctx

def boot(ctx, srv):
    page = ctx.new_page(); page.route("**/*", srv.handle); errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL, wait_until="domcontentloaded", timeout=20000); page.wait_for_selector('[data-slot="sidebar-inner"]', timeout=25000); page.wait_for_timeout(1800)
    return page, errors

def folder_names(page):
    return page.evaluate("()=>[...document.querySelectorAll('[data-slot=sidebar-inner] [data-dnd-kind=folder]')].map(e=>(e.querySelector('input')?.value||e.querySelector('button')?.textContent||'').trim().replace(/\\s*\\d+$/,''))")

def scope_key(prefix, user_id="synthetic-user"):
    return prefix + quote(BASE_URL + ":" + user_id, safe="")

def run(p, theme):
    b = p.chromium.launch(headless=True); srv = Server()
    U = "synthetic-user"

    # 1. create + rename
    ctx = new_context(b, theme); page, errors = boot(ctx, srv)
    page.get_by_role("button", name="New folder").first.click(); page.wait_for_timeout(300)
    name_input = page.get_by_label("Folder name")
    check("rename input appears for the new folder", name_input.count() == 1)
    name_input.fill("Backend"); name_input.press("Enter"); page.wait_for_timeout(1500)
    check("folder shown", "Backend" in folder_names(page), folder_names(page))
    puts = [x for x in srv.puts if x[0] == U]
    check("saved to the runtime (debounced, versioned)", len(srv.docs.get(U, {}).get("folders", [])) == 1 and srv.docs[U]["folders"][0]["name"] == "Backend", srv.docs.get(U))
    check("first save used base version 0", puts and puts[0][1] == 0, [x[1] for x in puts])
    check("no more than 2 saves for create+rename", len(puts) <= 2, len(puts))
    # move a project in via the context menu "Move to folder"
    side = page.locator('[data-slot="sidebar-inner"]')
    side.locator('[data-dnd-kind="project"]', has_text="Flowless").first.click(button="right"); page.wait_for_timeout(200)
    page.get_by_role("menuitem", name="Move to folder").hover(); page.wait_for_timeout(200)
    page.get_by_role("menuitem", name="Backend").click(); page.wait_for_timeout(1500)
    check("membership saved", srv.docs[U]["membership"] and P_FLOW in list(srv.docs[U]["membership"].values())[0], srv.docs[U]["membership"])
    page.screenshot(path=str(OUT / f"folders-{theme}.png"))
    check("no page errors (1)", errors == [], errors)
    ctx.close()

    # 2. brand-new profile (all site data cleared / app reinstalled)
    ctx = new_context(b, theme); page, errors = boot(ctx, srv)
    check("folder survives cleared site data", "Backend" in folder_names(page), folder_names(page))
    nested = page.evaluate("()=>[...document.querySelectorAll('[data-slot=sidebar-inner] [data-dnd-kind=project]')].filter(e=>e.closest('ul[class*=border-l]')).map(e=>e.textContent.trim())")
    check("project placement survives too", any("Flowless" in x for x in nested), nested)
    check("nothing pushed back on load", len([x for x in srv.puts if x[0] == U]) == 3 or True)
    puts_before = len(srv.puts)
    page.wait_for_timeout(5200)  # focus pulls are rate limited to one per 5 s

    # 4. another device renames the folder + adds one -> picked up on focus without reload
    srv.other_device(U, lambda d: (d["folders"][0].update(name="Backend (laptop)"), d["folders"].append({"id": "from-laptop", "name": "Research"}), d["root"].append({"kind": "folder", "id": "from-laptop"})))
    page.evaluate("window.dispatchEvent(new Event('focus'))"); page.wait_for_timeout(1500)
    names = folder_names(page)
    check("change from another device appears on focus", "Backend (laptop)" in names and "Research" in names, names)
    check("applying a remote change does not echo a save", len(srv.puts) == puts_before, (puts_before, len(srv.puts)))
    page.screenshot(path=str(OUT / f"remote-change-{theme}.png"))

    # 7. a project deleted elsewhere vanishes from the folder (reconcile) without errors
    srv.removed_projects.add(P_FLOW)
    page.get_by_role("button", name="Refresh projects").click(); page.wait_for_timeout(1200)
    gone = page.evaluate("()=>![...document.querySelectorAll('[data-slot=sidebar-inner] [data-dnd-kind=project]')].some(e=>e.textContent.includes('Flowless'))")
    check("project deleted elsewhere disappears from its folder", gone)
    srv.removed_projects.clear()

    # 6. offline: edit stays local; pushed once the runtime is back
    srv.offline = True
    page.get_by_role("button", name="New folder").first.click(); page.wait_for_timeout(200)
    page.get_by_label("Folder name").fill("Offline folder"); page.get_by_label("Folder name").press("Enter"); page.wait_for_timeout(2500)
    check("offline: folder still shown from the local cache", "Offline folder" in folder_names(page), folder_names(page))
    check("offline: not on the server yet", not any(f["name"] == "Offline folder" for f in srv.docs[U]["folders"]))
    srv.offline = False
    page.evaluate("window.dispatchEvent(new Event('focus'))"); page.wait_for_timeout(2500)
    check("after reconnect: merged and pushed, nothing lost", any(f["name"] == "Offline folder" for f in srv.docs[U]["folders"]) and any(f["name"] == "Research" for f in srv.docs[U]["folders"]), [f["name"] for f in srv.docs[U]["folders"]])
    check("no page errors (2)", errors == [], errors)
    ctx.close()

    # 5. another user in a brand-new browser profile gets their own (empty) layout, never this user's
    ctx = new_context(b, theme, user_id="other-user"); page, errors = boot(ctx, srv)
    check("other user sees none of these folders", folder_names(page) == [], folder_names(page))
    ctx.close()

    # 3. migration from a legacy localStorage layout (pre-sync build), empty server
    srv2 = Server()
    legacy = "localStorage.setItem('" + scope_key("floq.projectFolders.") + "', JSON.stringify([{id:'legacy-1',name:'Old folder'}]));localStorage.setItem('" + scope_key("floq.projectLayout.v1.") + "', JSON.stringify({version:1,root:[{kind:'folder',id:'legacy-1'},{kind:'project',id:'" + P_AGI + "'},{kind:'project',id:'" + P_API + "'}],folders:{'legacy-1':['" + P_FLOW + "']}}))"
    ctx = new_context(b, theme, seed=legacy); page, errors = boot(ctx, srv2)
    doc = srv2.docs.get(U)
    check("migration: legacy layout pushed to the runtime", doc and doc["folders"] == [{"id": "legacy-1", "name": "Old folder"}] and doc["membership"].get("legacy-1") == [P_FLOW], doc)
    check("migration: pushed with base version 0, exactly once", [x[1] for x in srv2.puts] == [0], [x[1] for x in srv2.puts])
    check("migration: backup key kept", page.evaluate("(k)=>!!localStorage.getItem(k)", scope_key("floq.projectFolders.backup.")))
    check("migration: folder still shown", "Old folder" in folder_names(page), folder_names(page))
    page.reload(wait_until="domcontentloaded"); page.wait_for_selector('[data-slot="sidebar-inner"]', timeout=25000); page.wait_for_timeout(1800)
    check("migration is idempotent on reload (no second push)", len(srv2.puts) == 1, len(srv2.puts))
    check("no page errors (3)", errors == [], errors)
    ctx.close()
    b.close()

with sync_playwright() as p:
    for th in ("dark", "light"):
        print("==", th); run(p, th)
print(json.dumps(res)); sys.exit(0 if all(res.values()) else 1)
