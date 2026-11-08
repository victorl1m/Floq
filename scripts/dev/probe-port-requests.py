"""Probe the agent port-request confirmation UI against the synthetic runtime fixture (stubbed /v1/port-requests).

Checks: dialog appears with agent/port/protocol/purpose, focus lands on Deny, countdown ticks, Esc defers to the footer,
Allow forwards (stubbed Tauri invoke) and tells the runtime, Deny tells the runtime, an expired request disables Allow,
and the right sidebar no longer has a Ports tab. Run with the dev server on :1421: python scripts/dev/probe-port-requests.py [light|dark]
"""
import os
import importlib.util, json, sys, time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "dev" / "verify-ui.py")
FIX = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(FIX)
CSPEC = importlib.util.spec_from_file_location("verify_canvas", ROOT / "scripts" / "dev" / "verify-final-canvas.py")
CANVAS = importlib.util.module_from_spec(CSPEC); CSPEC.loader.exec_module(CANVAS)
OUT = ROOT / "docs" / "redesign"; OUT.mkdir(parents=True, exist_ok=True)
THEME = sys.argv[1] if len(sys.argv) > 1 else "dark"

TAURI_STUB = """
window.__invokeLog = [];
window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => { window.__invokeLog.push([cmd, args]); return null; }, transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } } };
window.isTauri = true;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
"""


class Fixture(CANVAS.CanvasFixture):
    def __init__(self):
        super().__init__()
        self.created = time.time()
        self.answers = []
        self.pending = {
            "req-1": {"sessionId": "agi-agent-2", "agentName": "SARAH", "port": 3000, "protocol": "http", "purpose": "preview the dev server", "privileged": False, "ttl": 60},
            "req-2": {"sessionId": "agi-agent-2", "agentName": "SARAH", "port": 80, "protocol": "http", "purpose": "serve the docs", "privileged": True, "ttl": 60},
        }

    def view(self, rid, p):
        left = max(0, int((p["ttl"] - (time.time() - self.created)) * 1000))
        return {"id": rid, "sessionId": p["sessionId"], "agentName": p["agentName"], "port": p["port"], "protocol": p["protocol"], "purpose": p["purpose"], "privileged": p["privileged"], "remainingMs": left, "timeoutMs": 60000}

    def handle(self, route):
        path = urlparse(route.request.url).path
        if path == "/v1/port-requests":
            body = {"requests": [self.view(r, p) for r, p in self.pending.items()]}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body)); return
        if path.startswith("/v1/port-requests/") and path.endswith("/resolve"):
            rid = path.split("/")[3]
            body = json.loads(route.request.post_data or "{}")
            if rid not in self.pending:
                route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": {"code": "not_found", "message": "That port request is no longer pending (it may have expired)"}})); return
            self.answers.append((rid, body.get("decision")))
            self.pending.pop(rid)
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"status": "ok"})); return
        super().handle(route)


def main():
    report = {"theme": THEME, "checks": {}}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
        context.add_init_script(TAURI_STUB + "localStorage.setItem('theme','" + THEME + "');localStorage.setItem('floq.material','mica');localStorage.setItem('floq.right-sidebar.v1',JSON.stringify({open:true,width:360,tab:'ports'}));localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIX.USER) + "}));")
        page = context.new_page(); errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        fixture = Fixture(); page.route("**/*", fixture.handle)
        page.goto(os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421/"), wait_until="domcontentloaded", timeout=15000)
        dialog = page.get_by_role("dialog", name="Open a port?")
        dialog.wait_for(timeout=10000)
        text = dialog.inner_text()
        c = report["checks"]
        c["dialogNamesAgentPortProtocolPurpose"] = all(s in text for s in ("SARAH", "3000", "HTTP", "preview the dev server"))
        c["focusOnDeny"] = page.evaluate("document.activeElement?.textContent?.trim()") == "Deny"
        c["queueNoted"] = "1 more waiting" in text
        s1 = dialog.locator("[data-slot=port-countdown]").inner_text()
        page.wait_for_timeout(2200)
        s2 = dialog.locator("[data-slot=port-countdown]").inner_text()
        c["countdownTicks"] = int(s2) < int(s1)
        c["liveRegionPolite"] = dialog.locator('[role=status][aria-live=polite]').count() == 1
        c["noPortsTab"] = page.get_by_role("tab", name="Ports").count() == 0
        c["persistedPortsTabFallsBack"] = page.evaluate("JSON.parse(localStorage.getItem('floq.right-sidebar.v1')).tab") in ("changes", "files", "conversations", "ports")
        page.screenshot(path=str(OUT / f"port-request-dialog-{THEME}.png"), animations="disabled")
        # Esc defers; the footer chip shows the waiting count and the popover lists the requests.
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        c["escDefers"] = page.get_by_role("dialog", name="Open a port?").count() == 0 or "req-2" in str(fixture.pending.keys())
        chip = page.locator("footer").get_by_role("button", name="Ports", exact=False)
        # req-2 is the next undismissed request; it is privileged and needs the acknowledgement.
        d2 = page.get_by_role("dialog", name="Open a port?")
        if d2.count():
            c["privilegedNeedsAck"] = d2.get_by_role("button", name="Allow").is_disabled()
            d2.get_by_role("checkbox").click()
            c["privilegedAckEnables"] = d2.get_by_role("button", name="Allow").is_enabled()
            d2.get_by_role("button", name="Deny").click(); page.wait_for_timeout(300)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        report["chipLabels"] = [b.get_attribute("aria-label") for b in chip.all()]
        c["footerChip"] = chip.count() >= 1 and "waiting" in (chip.first.get_attribute("aria-label") or "")
        chip.click(); page.wait_for_timeout(300)
        pop = page.locator("[data-slot=popover-content]")
        c["popoverListsRequest"] = "preview the dev server" in pop.inner_text()
        page.screenshot(path=str(OUT / f"port-request-footer-{THEME}.png"), animations="disabled")
        pop.get_by_role("button", name="Allow").click(); page.wait_for_timeout(400)
        log = page.evaluate("window.__invokeLog")
        c["allowStartsForward"] = any(cmd == "port_forward_start" and a.get("port") == 3000 for cmd, a in log)
        c["runtimeToldAllow"] = ("req-1", "allow") in fixture.answers
        c["runtimeToldDeny"] = ("req-2", "deny") in fixture.answers
        report["errors"] = errors
        c["noPageErrors"] = not errors
        context.close(); browser.close()
    report["ok"] = all(report["checks"].values())
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
