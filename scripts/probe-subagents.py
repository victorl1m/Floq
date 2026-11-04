"""Probe the always-recruit-subagents UI against the synthetic runtime fixture.

Checks: the canvas node of a session with a recruiting parent shows a labelled "Subagent" badge (and the root agent does not),
Settings > Agents has the default-on "Always recruit subagents" switch that PATCHes alwaysRecruitSubagents, and the fixed
instruction preview is a collapsed disclosure (aria-expanded) that opens into a read-only labelled textarea.
Run with the dev server on :1421: python scripts/probe-subagents.py [light|dark]
"""
import os
import importlib.util, json, sys
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

POLICY = {
    "enabled": True,
    "limits": {"maxDepth": 2, "maxChildren": 6, "maxTotal": 24},
    "tools": [{"name": "floq_recruit_subagent", "command": "floq subagent recruit", "summary": "Start a subagent"}],
    "instruction": "[FLOQ SUBAGENT POLICY v1]\nYou are running inside Floq.\n- floq_recruit_subagent: floq subagent recruit\n[/FLOQ SUBAGENT POLICY]",
}


class Fixture(CANVAS.CanvasFixture):
    def __init__(self):
        super().__init__()
        self.patches = []

    def handle(self, route):
        req = route.request
        path = urlparse(req.url).path
        if path == "/v1/subagents/policy":
            route.fulfill(status=200, content_type="application/json", body=json.dumps(POLICY)); return
        if path == "/v1/settings" and req.method == "PATCH":
            self.patches.append(json.loads(req.post_data or "{}"))
        super().handle(route)


def main():
    child = next(s for s in CANVAS.FIX.SESSIONS if s["id"] == "agi-agent-2")
    root = next(s for s in CANVAS.FIX.SESSIONS if s["id"] == "agi-agent-1")
    child["parentSessionId"] = root["id"]
    report = {"theme": THEME, "checks": {}}
    c = report["checks"]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
        context.add_init_script("localStorage.setItem('theme','" + THEME + "');localStorage.setItem('floq.material','glass');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIX.USER) + "}));")
        page = context.new_page(); errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        fixture = Fixture(); page.route("**/*", fixture.handle)
        page.goto(os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421/"), wait_until="domcontentloaded", timeout=15000)
        page.get_by_role("heading", name="Start a new task").wait_for(timeout=10000)

        page.get_by_role("button", name="AGI Paulo - SARAH", exact=True).click()
        node = page.locator('.react-flow__node[data-id="agi-agent-2"]'); node.wait_for(state="visible", timeout=10000)
        page.wait_for_timeout(600)
        badge = node.get_by_label("Subagent of", exact=False)
        c["childHasSubagentBadge"] = badge.count() == 1 and "Subagent" in badge.inner_text()
        c["badgeNamesParent"] = (badge.get_attribute("aria-label") or "").startswith("Subagent of ")
        c["rootHasNoBadge"] = page.locator('.react-flow__node[data-id="agi-agent-1"]').get_by_label("Subagent of", exact=False).count() == 0
        page.screenshot(path=str(OUT / ("subagent-badge-" + THEME + ".png")), animations="disabled")

        page.get_by_role("button", name="Avery Example").click()
        page.get_by_role("menuitem", name="Settings").click()
        page.get_by_role("button", name="Agents").click()
        switch = page.get_by_role("switch", name="Always recruit subagents")
        switch.wait_for(timeout=5000)
        c["defaultOn"] = switch.get_attribute("aria-checked") == "true"
        toggle = page.get_by_role("button", name="Show fixed instruction")
        c["previewCollapsed"] = toggle.get_attribute("aria-expanded") == "false"
        toggle.click()
        area = page.get_by_label("Fixed Floq subagent instruction (read-only)")
        area.wait_for(timeout=5000)
        c["previewReadOnly"] = area.get_attribute("readonly") is not None and "FLOQ SUBAGENT POLICY" in area.input_value()
        c["previewExpanded"] = page.get_by_role("button", name="Hide fixed instruction").get_attribute("aria-expanded") == "true"
        switch.click()
        page.wait_for_timeout(300)
        c["togglePatchesRuntime"] = {"alwaysRecruitSubagents": False} in fixture.patches
        page.screenshot(path=str(OUT / ("subagent-settings-" + THEME + ".png")), animations="disabled")
        c["noPageErrors"] = not errors
        browser.close()
    report["passed"] = all(c.values())
    (OUT / ("subagents-verification-" + THEME + ".json")).write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["passed"] else 1)


main()
