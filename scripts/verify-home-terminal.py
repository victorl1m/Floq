"""Opening a Terminal with no project selected must create a home shell (no projectId, home:true), never ask for a project.
Synthetic runtime only. Run: FLOQ_UI_URL=http://127.0.0.1:1421 python scripts/verify-home-terminal.py"""
import importlib.util, json, os, sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "verify-ui.py")
FIX = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(FIX)
URL = os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421")

class HomeFixture(FIX.Fixture):
    def __init__(self):
        super().__init__(); self.empty = True; self.posts = []; self.created = []
    def handle(self, route):
        req = route.request; path = urlparse(req.url).path
        if path == "/v1/sessions" and req.method == "POST":
            payload = json.loads(req.post_data or "{}"); self.posts.append(payload)
            session = {**FIX.SESSION, "id": f"home-shell-{len(self.posts)}", "title": "Terminal", "provider": "shell", "projectId": None, "worktreeId": None, "cwd": ".", "projectCwd": None, "state": "running"}
            session.pop("role", None); self.created.append(session)
            route.fulfill(status=201, content_type="application/json", body=json.dumps({"session": session, **session})); return
        if path == "/v1/sessions" and req.method == "GET":
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"sessions": self.created})); return
        super().handle(route)

def main():
    fixture = HomeFixture(); errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True); context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.add_init_script("localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIX.USER) + "}));")
        page = context.new_page(); page.on("pageerror", lambda e: errors.append(str(e))); page.route("**/*", fixture.handle)
        page.goto(URL, wait_until="domcontentloaded", timeout=15000)
        page.locator("#app-navigation-sidebar").get_by_role("button", name="Terminal", exact=True).click()
        page.wait_for_timeout(1500)
        body = page.locator("body").inner_text()
        assert fixture.posts, "no POST /v1/sessions was made"
        first = fixture.posts[0]
        assert first.get("provider") == "shell" and first.get("home") is True, first
        assert "projectId" not in first and "workspaceId" not in first and "cwd" not in first, first
        assert "Choose a project" not in body and "Choose project" not in body, "project gate still shown"
        page.get_by_role("button", name="Stop terminal Terminal").wait_for(timeout=5000)
        assert page.get_by_label("Working directory ~").count() == 1, "tab does not show ~"
        page.screenshot(path=str(ROOT / "docs" / "redesign" / "home-terminal.png"))
        print(json.dumps({"posts": fixture.posts, "errors": errors, "ok": True}, indent=1))
        browser.close()
if __name__ == "__main__": main()
