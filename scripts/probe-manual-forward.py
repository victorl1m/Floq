"""Probe manual port forwarding with NO session active/running (stubbed runtime + Tauri invoke).
Checks: field/button enabled with no session, 3000 creates a home shell (POST /v1/sessions home:true, title 'Port forwarding')
then port_forward_start with that session's manual tunnel URL, preparing + error states, Enter submits, reuse on 2nd forward.
Run with the dev server on :1421: python scripts/probe-manual-forward.py [light|dark]
"""
import importlib.util, json, sys, time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
def load(name, f):
    s = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
FIX = load("verify_ui", "verify-ui.py")
OUT = ROOT / "docs" / "redesign"; OUT.mkdir(parents=True, exist_ok=True)
THEME = sys.argv[1] if len(sys.argv) > 1 else "dark"
TAURI_STUB = """
window.__invokeLog = [];
window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => { window.__invokeLog.push([cmd, args]); return null; }, transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } } };
window.isTauri = true;
window.__sawPreparing = false; new MutationObserver(() => { if (document.body && document.body.innerText.includes("Preparing a shell")) window.__sawPreparing = true; }).observe(document, { subtree: true, childList: true, characterData: true });
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
"""

def make_fixture():
    base = [c for c in vars(FIX).values() if isinstance(c, type) and hasattr(c, "handle")][0]
    class F(base):
        def __init__(self):
            super().__init__(); self.posts = []; self.fail = False; self.sessions = []
        def handle(self, route):
            path = urlparse(route.request.url).path
            if path == "/v1/sessions" and route.request.method == "POST":
                body = json.loads(route.request.post_data or "{}"); self.posts.append(body)
                if self.fail:
                    route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": {"code": "unavailable", "message": "No capacity"}})); return
                s = {"id": "home-shell-1", "provider": "shell", "title": body.get("title"), "state": "running", "cwd": "/home/u", "projectId": None, "cols": 80, "rows": 24, "createdAt": "2026-11-04T00:00:00Z", "startedAt": "2026-11-04T00:00:00Z", "endedAt": None, "exitCode": None, "signal": None, "pid": 42, "seq": 0, "bufferedBytes": 0, "droppedBytes": 0, "resumeCount": 0, "sleepReason": None}
                self.sessions.append(s)
                route.fulfill(status=201, content_type="application/json", body=json.dumps({"session": s})); return
            if path == "/v1/sessions":
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"sessions": self.sessions})); return
            if path == "/v1/projects":
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"projects": []})); return
            super().handle(route)
    return F()

def main():
    c = {}; report = {"theme": THEME, "checks": c}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
        context.add_init_script(TAURI_STUB + "localStorage.setItem('theme','" + THEME + "');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIX.USER) + "}));")
        page = context.new_page(); errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        fx = make_fixture(); page.route("**/*", fx.handle)
        page.goto("http://127.0.0.1:1421/", wait_until="domcontentloaded", timeout=15000); page.wait_for_timeout(2500)
        chip = page.locator("footer").get_by_role("button", name="Ports", exact=False); chip.click(); page.wait_for_timeout(300)
        pop = page.locator("[data-slot=popover-content]")
        field = pop.get_by_label("Port to forward"); btn = pop.get_by_role("button", name="Forward", exact=True)
        c["fieldEnabledNoSession"] = field.is_enabled()
        c["noOldHelper"] = "Open a session or terminal" not in pop.inner_text()
        field.fill("3000"); c["buttonEnabledWithValue"] = btn.is_enabled()
        page.screenshot(path=str(OUT / f"manual-forward-idle-{THEME}.png"), animations="disabled")
        field.press("Enter")
        c["preparingShown"] = page.wait_for_timeout(300) or page.evaluate("window.__sawPreparing")
        page.screenshot(path=str(OUT / f"manual-forward-preparing-{THEME}.png"), animations="disabled")
        page.wait_for_timeout(1200)
        log = page.evaluate("window.__invokeLog")
        c["createdHomeShell"] = len(fx.posts) == 1 and fx.posts[0].get("home") is True and fx.posts[0].get("provider") == "shell" and "projectId" not in fx.posts[0] and "cwd" not in fx.posts[0]
        starts = [a for cmd, a in log if cmd == "port_forward_start"]
        c["tunnelInvoked"] = len(starts) == 1 and starts[0]["port"] == 3000 and "/v1/sessions/home-shell-1/ports/3000/tunnel" in starts[0]["url"] and "manual=1" in starts[0]["url"]
        # second port reuses the shell
        field.fill("3001"); field.press("Enter"); page.wait_for_timeout(800)
        c["reusedShell"] = len(fx.posts) == 1 and len([1 for cmd, _ in page.evaluate("window.__invokeLog") if cmd == "port_forward_start"]) == 2
        # duplicate
        field.fill("3000"); field.press("Enter"); page.wait_for_timeout(300)
        c["duplicateRefused"] = "already forwarded" in pop.inner_text(); report["popText"] = pop.inner_text()
        page.reload(wait_until="domcontentloaded"); page.wait_for_timeout(2000)
        # error state: fresh runtime without the shell
        fx.sessions = []; fx.fail = True; fx.posts.clear()
        page.reload(wait_until="domcontentloaded"); page.wait_for_timeout(2500)
        page.evaluate("window.__invokeLog.length = 0")
        chip.click(); page.wait_for_timeout(300)
        field.fill("4000"); field.press("Enter"); page.wait_for_timeout(1500)
        c["errorShown"] = "Could not prepare a shell" in pop.inner_text() and pop.locator("[role=alert]").count() == 1
        c["noTunnelOnError"] = not [1 for cmd, _ in page.evaluate("window.__invokeLog") if cmd == "port_forward_start"]
        c["fieldReenabled"] = field.is_enabled()
        page.screenshot(path=str(OUT / f"manual-forward-error-{THEME}.png"), animations="disabled")
        c["noPageErrors"] = not errors; report["errors"] = errors
        context.close(); browser.close()
    report["ok"] = all(c.values()); print(json.dumps(report, indent=2)); sys.exit(0 if report["ok"] else 1)

if __name__ == "__main__":
    main()
