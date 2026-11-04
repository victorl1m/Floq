"""Delete-project probe on the synthetic fixture runtime (dev server; FLOQ_UI_URL, default http://127.0.0.1:1431/).

Covers: entry points (context menu + "..." menu), dialog contents (counts, dirty warning), default focus on Cancel,
type-to-confirm gating, loading state, error toast + dialog stays, success (project gone from sidebar, canvas left for
Home, DELETE sent exactly once), Cancel sends nothing. Light and dark screenshots in docs/redesign/delete-project/.
"""
import importlib.util, json, os, sys, time
from pathlib import Path
from urllib.parse import urlparse
import re
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
def load(n, f):
    s = importlib.util.spec_from_file_location(n, ROOT / "scripts" / f); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
FIX = load("verify_ui", "verify-ui.py"); CANVAS = load("vfc", "verify-final-canvas.py")
OUT = ROOT / "docs" / "redesign" / "delete-project"; OUT.mkdir(parents=True, exist_ok=True)
URL = os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1431/")
NAME = "AGI Paulo - SARAH"

STATUS = {
    "project": {"id": "project-agi", "name": NAME},
    "sessions": {"total": 3, "live": 2}, "notes": 4, "keychains": 1,
    "checkouts": [
        {"workspaceId": "agi-main", "path": ".floq/projects/project-agi", "kind": "project", "branch": "main", "managed": True, "state": "ok", "uncommittedFiles": 0},
        {"workspaceId": "agi-research", "path": ".floq/worktrees/0f0f0f0f-0000-4000-8000-000000000001", "kind": "worktree", "branch": "floq/research-pass", "managed": True, "state": "ok", "uncommittedFiles": 5},
    ],
    "worktrees": 1, "dirtyWorktrees": 1, "dirtyMainCheckout": False, "unmanagedCheckouts": 0, "unreadableCheckouts": 0,
}

class Fx(CANVAS.CanvasFixture):
    def __init__(self):
        super().__init__(); self.deleted = set(); self.dels = []; self.fail = False; self.hold = False; self.held = None; self.status_calls = 0
    def handle(self, route):
        req = route.request; path = urlparse(req.url).path
        m = re.fullmatch(r"/v1/projects/([^/]+)/delete-status", path)
        if m and req.method == "GET":
            self.status_calls += 1
            body = {**STATUS, "project": {"id": m.group(1), "name": NAME}}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body)); return
        m = re.fullmatch(r"/v1/projects/([^/]+)", path)
        if m and req.method == "DELETE":
            self.dels.append(m.group(1))
            if self.hold:
                self.held = route; return
            if self.fail:
                route.fulfill(status=409, content_type="application/json", body=json.dumps({"error": {"code": "conflict", "message": "The runtime could not delete this project right now."}})); return
            self.deleted.add(m.group(1))
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"deleted": True, "sessionsDeleted": 3, "removedCheckouts": 2, "leftovers": []})); return
        if path == "/v1/projects" and req.method == "GET":
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"projects": [p for p in FIX.PROJECTS if p["id"] not in self.deleted]})); return
        if path == "/v1/sessions" and req.method == "GET":
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"sessions": [s for s in FIX.SESSIONS if s["projectId"] not in self.deleted]})); return
        super().handle(route)

res = {}
def check(name, ok, info=""):
    res[name] = bool(ok); print(("PASS " if ok else "FAIL ") + name, info)
def toasts(page): return page.evaluate(r"()=>[...document.querySelectorAll('[data-sonner-toast]')].map(t=>t.innerText.split(String.fromCharCode(10)).join(' | '))")

def run(p, theme):
    b = p.chromium.launch(headless=True); ctx = b.new_context(viewport={"width": 1440, "height": 960})
    ctx.add_init_script("localStorage.setItem('theme','" + theme + "');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIX.USER) + "}));")
    page = ctx.new_page(); errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
    fx = Fx(); page.route("**/*", fx.handle)
    page.goto(URL, wait_until="domcontentloaded", timeout=20000); page.wait_for_selector('[data-slot="sidebar-inner"]', timeout=25000); page.wait_for_timeout(1500)
    side = page.locator('[data-slot="sidebar-inner"]')

    # --- "..." menu entry point on another project (menu item exists, opens the dialog, Cancel sends nothing)
    row = side.locator('[data-dnd-kind="project"]', has_text="Flowless").first
    row.hover(); row.get_by_role("button", name=re.compile("^Actions for")).click(); page.wait_for_timeout(200)
    item = page.get_by_role("menuitem", name=re.compile("^Delete project"))
    check("dots menu has Delete project", item.count() == 1)
    item.click(); page.wait_for_timeout(500)
    dlg = page.get_by_role("alertdialog")
    check("dialog opens from dots menu", dlg.count() == 1)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    check("escape closes, nothing deleted", dlg.count() == 0 and fx.dels == [])

    # --- open the project's canvas, then delete through the context menu
    side.get_by_text(NAME).first.click(); page.wait_for_timeout(900)
    check("canvas open", page.locator(".react-flow__node").count() >= 1)
    side.get_by_text(NAME).first.click(button="right"); page.wait_for_timeout(200)
    page.get_by_role("menuitem", name=re.compile("^Delete project")).click(); page.wait_for_timeout(700)
    dlg = page.get_by_role("alertdialog")
    check("dialog title names the project", dlg.get_by_role("heading", name=re.compile(re.escape(NAME))).count() == 1)
    text = dlg.inner_text()
    check("lists session counts", "3 agent and terminal sessions" in text and "2 running" in text, text[:200].replace("\n", " | "))
    check("lists notes/keychains", "4 canvas notes" in text and "1 keychain" in text)
    check("lists checkout + worktree", ".floq/projects/project-agi" in text and "1 worktree" in text)
    check("dirty worktree warning", "1 worktree has uncommitted changes that will be lost" in text, text)
    check("remote untouched statement", "original remote repository" in text)
    focused = page.evaluate("document.activeElement?.textContent?.trim()")
    check("default focus is Cancel", focused == "Cancel", focused)
    btn = dlg.get_by_role("button", name="Delete project")
    check("delete disabled initially", btn.is_disabled())
    field = dlg.get_by_label(re.compile("^Type .* to confirm"))
    field.fill("AGI Paulo"); check("disabled for partial name", btn.is_disabled())
    field.fill(NAME.lower()); check("disabled for wrong case", btn.is_disabled())
    page.screenshot(path=str(OUT / f"dialog-gated-{theme}.png"))
    field.fill(NAME); check("enabled when name matches", btn.is_enabled())
    page.screenshot(path=str(OUT / f"dialog-ready-{theme}.png"))

    # --- error path
    fx.fail = True; btn.click(); page.wait_for_timeout(700)
    check("error: dialog stays open", page.get_by_role("alertdialog").count() == 1)
    t = toasts(page); check("error: toast", any("Could not delete the project" in x for x in t), t)
    check("error: inline message", "could not delete this project right now" in page.get_by_role("alertdialog").inner_text())
    check("error: project still listed", side.get_by_text(NAME).count() >= 1)
    page.screenshot(path=str(OUT / f"dialog-error-{theme}.png"))

    # --- success with a visible loading state
    fx.fail = False; fx.hold = True; fx.dels.clear()
    page.get_by_role("alertdialog").get_by_role("button", name="Delete project").click(); page.wait_for_timeout(500)
    loading = page.get_by_role("alertdialog").get_by_role("button", name="Deleting…")
    check("loading state", loading.count() == 1 and loading.get_attribute("aria-busy") == "true" and loading.is_disabled())
    check("cancel disabled while deleting", page.get_by_role("alertdialog").get_by_role("button", name="Cancel").is_disabled())
    page.screenshot(path=str(OUT / f"dialog-deleting-{theme}.png"))
    fx.hold = False; fx.deleted.add("project-agi")
    fx.held.fulfill(status=200, content_type="application/json", body=json.dumps({"deleted": True, "sessionsDeleted": 3, "removedCheckouts": 2, "leftovers": []}))
    page.wait_for_timeout(1500)
    check("dialog closed", page.get_by_role("alertdialog").count() == 0)
    check("DELETE sent exactly once", fx.dels == ["project-agi"], fx.dels)
    check("project gone from sidebar", side.get_by_text(NAME).count() == 0)
    check("sessions gone from sidebar", side.get_by_text("Outline the evaluation plan").count() == 0)
    check("navigated away from canvas", page.locator(".react-flow__node").count() == 0 and page.get_by_role("heading", name="Start a new task").count() == 1)
    t = toasts(page); check("success toast", any("Deleted" in x for x in t), t)
    page.screenshot(path=str(OUT / f"after-delete-{theme}.png"))
    check("no page errors", errors == [], errors)
    b.close()

with sync_playwright() as p:
    for th in ("dark", "light"):
        print("==", th); run(p, th)
print(json.dumps(res)); sys.exit(0 if all(res.values()) else 1)
