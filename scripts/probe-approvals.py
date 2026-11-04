"""Probe the user-approval prompt against the synthetic runtime fixture (stubbed /v1/approvals + a fake events socket).

Checks: contents, irreversible styling, focus on Deny, Enter never allows (Ctrl/Cmd+Enter does), Esc defers to the pill and
footer chip, the prompt is on top of Home, Canvas, Settings and the command palette without closing them, stack navigation,
countdown, outcome state, POST payloads, light/dark screenshots.
Run with the dev server on :1421: python scripts/probe-approvals.py [light|dark]
"""
import os
import importlib.util, json, sys, time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "verify-ui.py")
FIX = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(FIX)
CSPEC = importlib.util.spec_from_file_location("verify_canvas", ROOT / "scripts" / "verify-final-canvas.py")
CANVAS = importlib.util.module_from_spec(CSPEC); CSPEC.loader.exec_module(CANVAS)
OUT = ROOT / "docs" / "redesign"; OUT.mkdir(parents=True, exist_ok=True)
THEME = sys.argv[1] if len(sys.argv) > 1 else "dark"

INIT = """
window.__invokeLog = [];
window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => { window.__invokeLog.push([cmd, args]); return null; }, transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } } };
window.isTauri = true;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
window.__sockets = [];
window.WebSocket = class { constructor(url){ this.url = url; this.readyState = 1; window.__sockets.push(this); setTimeout(() => this.onopen && this.onopen({}), 10); } send(){} close(){ this.readyState = 3; } };
window.__push = (frame) => window.__sockets.forEach((s) => s.onmessage && s.onmessage({ data: JSON.stringify(frame) }));
"""


def ref(i, name, provider, pid, pname):
    return {"id": i, "name": name, "provider": provider, "projectId": pid, "projectName": pname}


SARAH = ref("agi-agent-2", "SARAH", "claude", "p1", "Acme Wrapper")
NEO = ref("agi-agent-3", "Globex Dev", "codex", "p2", "Globex Console")


class Fixture(CANVAS.CanvasFixture):
    def __init__(self):
        super().__init__()
        self.answers = []
        self.pending = {}
        self.n = 0
        self.add("A" * 26, "git push origin main", "Fast-forward main with 3 commits (feature/approvals).", True, 600, SARAH, NEO)

    def add(self, rid, action, detail, irreversible, ttl, requester, target):
        self.n += 1
        self.pending[rid] = {"id": rid, "requester": requester, "target": target, "action": action, "detail": detail, "irreversible": irreversible,
                             "createdAt": "2026-11-04T10:00:%02d.000Z" % self.n, "ttl": ttl, "t0": time.time()}

    def view(self, rid):
        p = self.pending[rid]
        left = max(0, int((p["ttl"] - (time.time() - p["t0"])) * 1000))
        v = {k: p[k] for k in ("id", "requester", "target", "action", "detail", "irreversible", "createdAt")}
        return {**v, "expiresAt": v["createdAt"], "remainingMs": left, "timeoutMs": p["ttl"] * 1000}

    def handle(self, route):
        path = urlparse(route.request.url).path
        if path == "/v1/approvals":
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"approvals": [self.view(r) for r in self.pending]})); return
        if path.startswith("/v1/approvals/") and path.endswith("/resolve"):
            rid = path.split("/")[3]
            body = json.loads(route.request.post_data or "{}")
            if rid not in self.pending:
                route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": {"code": "not_found", "message": "That approval request is no longer pending (it may have expired)"}})); return
            self.answers.append((rid[0], body.get("decision"))); self.pending.pop(rid)
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"status": "granted" if body.get("decision") == "allow" else "denied"})); return
        super().handle(route)


def top_most(page, selector):
    """True when the element painted at the prompt's centre belongs to the prompt (nothing paints over it)."""
    return page.evaluate("""(sel) => { const d = document.querySelector(sel); if (!d) return false; const r = d.getBoundingClientRect();
      const e = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height - 4, 40)); return !!e && d.contains(e); }""", selector)


def push(page, fixture, rid, **kw):
    fixture.add(rid, **kw)
    page.evaluate("(a) => window.__push({type:'approval-request',approval:a})", fixture.view(rid))
    page.wait_for_timeout(500)


def main():
    report = {"theme": THEME, "checks": {}}
    c = report["checks"]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
        context.add_init_script(INIT + "localStorage.setItem('theme','" + THEME + "');localStorage.setItem('floq.material','glass');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIX.USER) + "}));")
        page = context.new_page(); errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        fixture = Fixture(); page.route("**/*", fixture.handle)
        page.goto(os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421/"), wait_until="domcontentloaded", timeout=15000)
        dialog = page.get_by_role("dialog", name="Approval needed")
        dialog.wait_for(timeout=10000)
        text = dialog.inner_text()
        c["namesRequesterAndTarget"] = all(s in text for s in ("SARAH", "Acme Wrapper", "Globex Dev", "Globex Console"))
        action = dialog.locator("[data-slot=approval-action]")
        c["showsExactActionMonospaced"] = action.inner_text() == "git push origin main" and "mono" in action.evaluate("e => getComputedStyle(e).fontFamily + ' ' + e.className")
        c["showsDetail"] = "Fast-forward main" in text
        c["irreversibleLabel"] = "Irreversible · affects production" in dialog.locator("[data-slot=approval-risk]").inner_text()
        c["focusOnDeny"] = page.evaluate("document.activeElement?.textContent?.trim()") == "Deny"
        c["kbdHints"] = "Esc" in text and ("Ctrl" in text or "⌘" in text)
        s1 = dialog.locator("[data-slot=approval-remaining]").inner_text(); page.wait_for_timeout(2200); s2 = dialog.locator("[data-slot=approval-remaining]").inner_text()
        c["countdownTicks"] = s1 != s2
        c["liveRegionPolite"] = dialog.locator("[role=status][aria-live=polite]").count() >= 1
        c["onTopOfHome"] = top_most(page, "[data-slot=approval-dialog]")
        c["zAboveToasts"] = page.evaluate("Number(getComputedStyle(document.querySelector('[data-slot=approval-dialog]')).zIndex)") > 2147483000
        c["titleHasCount"] = page.title().startswith("(1) ")
        page.screenshot(path=str(OUT / f"approval-single-{THEME}.png"), animations="disabled")

        # Esc defers: dialog gone, pill + footer chip show, nothing was posted.
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        c["escDefersNotDenies"] = page.get_by_role("dialog", name="Approval needed").count() == 0 and fixture.answers == []
        pill = page.locator("[data-slot=approval-pill]")
        c["pillShown"] = pill.count() == 1 and "1 approval waiting" in pill.inner_text()
        c["footerChip"] = page.locator("footer").get_by_role("button", name="1 approval waiting", exact=False).count() == 1
        pill.click(); page.wait_for_timeout(300)
        c["pillReopens"] = page.get_by_role("dialog", name="Approval needed").count() == 1
        page.keyboard.press("Escape"); page.wait_for_timeout(200)

        # Over Settings: a new request arrives while Settings is open; it stacks on top and Settings stays open.
        page.keyboard.press("Control+,"); page.wait_for_timeout(600)
        settings_open = page.locator("[data-slot=dialog-content]").count() >= 1
        push(page, fixture, "B" * 26, action="deploy to production", detail="", irreversible=True, ttl=300, requester=NEO, target=NEO)
        c["overSettingsVisible"] = settings_open and page.get_by_role("dialog", name="Approval needed").count() == 1 and top_most(page, "[data-slot=approval-dialog]")
        stack = page.locator("[data-slot=approval-stack]").inner_text()
        c["overSettingsStack"] = "2 pending" in stack and "1 of 2" in stack
        c["newestFirst"] = "deploy to production" in page.locator("[data-slot=approval-action]").inner_text()
        page.screenshot(path=str(OUT / f"approval-stacked-over-settings-{THEME}.png"), animations="disabled")
        page.get_by_role("button", name="Next approval").click(); page.wait_for_timeout(200)
        c["nextShowsOlder"] = "git push origin main" in page.locator("[data-slot=approval-action]").inner_text()
        for _ in range(8): page.keyboard.press("Tab")
        c["focusTrapped"] = page.evaluate("!!document.activeElement.closest('[data-slot=approval-dialog]')")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        c["settingsSurvivesEsc"] = page.locator("[data-slot=dialog-content]").count() >= 1 and page.locator("[data-slot=approval-pill]").count() == 1
        page.locator("[data-slot=approval-pill]").click(); page.wait_for_timeout(300)
        c["pillOverSettingsKeepsSettings"] = page.get_by_role("dialog", name="Approval needed").count() == 1 and page.locator("[data-slot=dialog-content]").count() >= 1
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        page.keyboard.press("Escape"); page.wait_for_timeout(400)  # closes Settings

        # Over the command palette.
        page.keyboard.press("Control+k"); page.wait_for_timeout(500)
        palette_open = page.get_by_role("dialog").count() >= 1
        push(page, fixture, "C" * 26, action="delete the remote branch feature/old", detail="", irreversible=True, ttl=300, requester=SARAH, target=SARAH)
        c["overPaletteVisible"] = palette_open and page.get_by_role("dialog", name="Approval needed").count() == 1 and top_most(page, "[data-slot=approval-dialog]")
        page.keyboard.press("Escape"); page.wait_for_timeout(300); page.keyboard.press("Escape"); page.wait_for_timeout(300)

        # Over the canvas.
        row = page.locator(".home-list-row").first
        c["canvasReachable"] = row.count() > 0
        if row.count():
            row.click(); page.wait_for_timeout(1500)
            c["pillOnCanvas"] = page.locator("[data-slot=approval-pill]").count() == 1
            page.locator("[data-slot=approval-pill]").click(); page.wait_for_timeout(400)
            c["overCanvasVisible"] = page.get_by_role("dialog", name="Approval needed").count() == 1 and top_most(page, "[data-slot=approval-dialog]")
            page.screenshot(path=str(OUT / f"approval-over-canvas-{THEME}.png"), animations="disabled")
        # Ctrl+Enter allows; plain Enter on the focused Deny only denies.
        page.keyboard.press("Control+Enter"); page.wait_for_timeout(400)
        out = page.locator("[data-slot=approval-outcome]")
        c["outcomeApproved"] = out.count() == 1 and "Approved · agent notified" in out.inner_text()
        c["ctrlEnterAllowPosted"] = any(d == "allow" for _, d in fixture.answers)
        page.wait_for_timeout(1700)
        c["outcomeLeaves"] = page.locator("[data-slot=approval-outcome]").count() == 0
        d = page.get_by_role("dialog", name="Approval needed")
        if d.count():
            c["denyFocusedAgain"] = page.evaluate("document.activeElement?.textContent?.trim()") == "Deny"
            page.keyboard.press("Enter"); page.wait_for_timeout(400)
            c["plainEnterDeniesNeverAllows"] = fixture.answers[-1][1] == "deny"
        page.wait_for_timeout(1700)
        # An expired approval cannot be allowed.
        fixture.add("D" * 26, action="merge release into main", detail="", irreversible=True, ttl=1, requester=SARAH, target=SARAH)
        page.evaluate("(a) => window.__push({type:'approval-request',approval:a})", {**fixture.view("D" * 26), "remainingMs": 1500})
        page.wait_for_timeout(2600)
        dd = page.get_by_role("dialog", name="Approval needed")
        c["expiredHasNoAllow"] = dd.count() == 0 or dd.get_by_role("button", name="Allow once").count() == 0
        report["answers"] = fixture.answers
        report["errors"] = errors
        c["noPageErrors"] = not errors
        context.close(); browser.close()
    report["ok"] = all(report["checks"].values())
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
