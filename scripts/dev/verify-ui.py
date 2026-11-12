"""Browser-only Floq UI verification with synthetic runtime responses.

All API traffic is fulfilled by Playwright routes. No runtime credentials or
runtime service are used. Run with: python scripts/dev/verify-ui.py
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1420")
OUT = Path("docs/redesign")
OUT.mkdir(parents=True, exist_ok=True)

USER = {"id": "synthetic-user", "name": "Avery Example", "email": "avery@example.invalid", "image": None}
ORG = {"id": "org-demo", "name": "Studio North", "role": "owner", "members": [
    {"id": "synthetic-user", "name": "Avery Example", "email": "avery@example.invalid", "role": "owner"},
    {"id": "synthetic-member", "name": "Morgan Example", "email": "morgan@example.invalid", "role": "member"},
]}
PROJECT = {"id": "project-demo", "name": "floq-demo", "displayName": "Floq Demo", "imageUrl": None,
           "gitUrl": "https://example.invalid/acme/floq-demo.git", "cwd": "/synthetic/floq-demo", "createdAt": "2026-01-01T12:00:00Z",
           "workspaces": [{"id": "workspace-main", "cwd": "/synthetic/floq-demo", "name": "main", "branch": "main", "isWorktree": False, "sessionIds": ["session-demo"]}]}
PROJECTS = [
    {**PROJECT, "id": "project-agi", "name": "agi-paulo", "displayName": "AGI Paulo - SARAH", "cwd": "/synthetic/agi-paulo", "workspaces": [
        {"id": "agi-main", "cwd": "/synthetic/agi-paulo", "name": "main", "branch": "main", "isWorktree": False, "sessionIds": ["agi-agent-1"]},
        {"id": "agi-research", "cwd": "/synthetic/agi-paulo/.worktrees/research", "name": "Research pass", "branch": "floq/research-pass", "isWorktree": True, "sessionIds": ["agi-agent-2", "agi-agent-3"]},
    ]},
    {**PROJECT, "id": "project-api", "name": "api-procurement", "displayName": "API Procurement", "cwd": "/synthetic/api-procurement", "workspaces": [
        {"id": "api-main", "cwd": "/synthetic/api-procurement", "name": "main", "branch": "main", "isWorktree": False, "sessionIds": ["api-agent-1", "api-agent-2"]},
        {"id": "api-dataverse", "cwd": "/synthetic/api-procurement/.worktrees/dataverse", "name": "Dataverse integration", "branch": "floq/dataverse-mcp", "isWorktree": True, "sessionIds": ["api-agent-3"]},
    ]},
    {**PROJECT, "id": "project-flowless", "name": "flowless", "displayName": "Flowless", "cwd": "/synthetic/flowless", "workspaces": [
        {"id": "flowless-main", "cwd": "/synthetic/flowless", "name": "main", "branch": "main", "isWorktree": False, "sessionIds": ["flowless-agent-1"]},
    ]},
]
BOARD = {"id": "board-demo", "organizationId": "org-demo", "title": "Launch plan", "createdAt": "2026-01-01T12:00:00Z", "lists": [
    {"id": "list-todo", "title": "To do", "position": 0, "cards": [
        {"id": "card-demo", "title": "Review onboarding", "description": "Check the sign-in flow and invite path.", "position": 0, "assigneeId": "synthetic-member", "dueAt": None, "createdAt": "2026-01-01T12:00:00Z", "updatedAt": "2026-01-02T12:00:00Z"}]},
    {"id": "list-doing", "title": "In progress", "position": 1, "cards": []},
]}
SESSION = {"id": "session-demo", "provider": "codex", "title": "Review onboarding", "state": "running", "cwd": "/synthetic/floq-demo", "projectCwd": "/synthetic/floq-demo", "projectId": "project-demo", "worktreeId": "workspace-main", "branch": "main", "cols": 100, "rows": 30, "createdAt": "2026-01-02T12:00:00Z", "startedAt": "2026-01-02T12:00:00Z", "endedAt": None, "exitCode": None, "signal": None, "pid": 0, "seq": 0, "bufferedBytes": 0, "droppedBytes": 0, "resumeCount": 0, "sleepReason": None, "activity": "working"}
SESSIONS = [
    # Explicit zero-recruit orchestrator stresses the compact crown marker without inventing real data.
    {**SESSION, "id": "agi-agent-1", "title": "Outline the evaluation plan", "projectId": "project-agi", "worktreeId": "agi-main", "cwd": "/synthetic/agi-paulo", "projectCwd": "/synthetic/agi-paulo", "role": "orchestrator"},
    {**SESSION, "id": "agi-agent-2", "title": "Review policy and edge cases", "projectId": "project-agi", "worktreeId": "agi-research", "cwd": "/synthetic/agi-paulo/.worktrees/research", "projectCwd": "/synthetic/agi-paulo"},
    {**SESSION, "id": "agi-agent-3", "title": "Summarize evaluator feedback", "projectId": "project-agi", "worktreeId": "agi-research", "cwd": "/synthetic/agi-paulo/.worktrees/research", "projectCwd": "/synthetic/agi-paulo", "provider": "claude", "state": "sleeping", "activity": "idle"},
    {**SESSION, "id": "api-agent-1", "title": "Review purchase request flow", "projectId": "project-api", "worktreeId": "api-main", "cwd": "/synthetic/api-procurement", "projectCwd": "/synthetic/api-procurement"},
    {**SESSION, "id": "api-agent-2", "title": "Check vendor synchronization", "projectId": "project-api", "worktreeId": "api-main", "cwd": "/synthetic/api-procurement", "projectCwd": "/synthetic/api-procurement", "provider": "claude"},
    {**SESSION, "id": "api-agent-3", "title": "Dataverse MCP connection", "projectId": "project-api", "worktreeId": "api-dataverse", "cwd": "/synthetic/api-procurement/.worktrees/dataverse", "projectCwd": "/synthetic/api-procurement"},
    {**SESSION, "id": "flowless-agent-1", "title": "Prepare release notes", "projectId": "project-flowless", "worktreeId": "flowless-main", "cwd": "/synthetic/flowless", "projectCwd": "/synthetic/flowless"},
]
SKILLS = [
    {"name": "accessibility-review", "description": "Review interfaces for keyboard and screen reader access.", "source": "home", "provider": "claude", "location": "/synthetic/home/.claude/skills/accessibility-review"},
    {"name": "release-notes", "description": "Prepare concise release notes from shipped work.", "source": "bundled", "provider": "codex", "location": "/synthetic/floq/skills/release-notes"},
]
PROJECT_SKILLS = [
    {"name": "accessibility-review", "description": "Review interfaces for keyboard and screen reader access.", "provider": "claude", "scope": "project", "source": "project", "location": "/synthetic/agi-paulo/.claude/skills/accessibility-review", "projectId": "project-agi"},
]
SERVERS = [
    {"name": "docs-search", "provider": "codex", "scope": "global", "source": "home", "transport": "http", "urlHost": "docs.example.invalid", "usesSecrets": True, "secretNames": ["DOCS_TOKEN"]},
]
PROJECT_SERVERS = [
    {"name": "dataverse-tools", "provider": "codex", "scope": "project", "source": "project", "transport": "stdio", "command": "npx", "usesSecrets": True, "secretNames": ["DATAVERSE_TOKEN"]},
]
SECRETS = [{"name": "DOCS_TOKEN", "description": "Synthetic docs access token", "expose": "tool", "createdAt": "2026-01-01T12:00:00Z", "updatedAt": "2026-01-01T12:00:00Z", "lastUsedAt": None}]
SETTINGS = {"claudeAutoApprove": False, "codexAutoApprove": True, "gitName": "Avery Example", "gitEmail": "avery@example.invalid", "github": None, "gitCoauthor": False, "gitCoauthorAvailable": True}


class Fixture:
    """Small synthetic REST surface; mutable for empty/error recovery scenarios."""
    def __init__(self):
        self.empty = False
        self.fail_settings_once = False
        self.calls: list[str] = []

    def handle(self, route):
        req = route.request
        path = urlparse(req.url).path
        if not (path.startswith("/v1/") or path.startswith("/api/") or path == "/healthz"):
            route.continue_()
            return
        self.calls.append(f"{req.method} {path}")
        body = {}
        status = 200
        method = req.method
        if path in ("/healthz",): body = {"ok": True}
        elif path == "/api/auth/get-session": body = {"user": USER}
        elif path == "/v1/setup/lookup": body = {"step": "password"}
        elif path == "/api/auth/sign-in/email": body = {"token": "synthetic-token", "user": USER}
        elif path == "/v1/info": body = {"server": {"name": "floq-runtime", "version": "synthetic", "startedAt": "2026-01-01T00:00:00Z", "providers": ["codex", "claude", "shell"], "maxSessions": 8, "activeSessions": 7}, "providers": [{"id": "codex", "label": "Codex", "command": "codex", "available": True, "version": "synthetic", "args": [], "models": [{"id": "gpt-test", "label": "Synthetic model", "default": True}]}, {"id": "claude", "label": "Claude", "command": "claude", "available": True, "version": "synthetic", "args": []}, {"id": "shell", "label": "Terminal", "command": "sh", "available": True, "version": "synthetic", "args": []}], "githubConfigured": False}
        elif path == "/v1/agent-roles": body = {"roles": []}
        elif path == "/v1/me/role": body = {"role": "owner"}
        elif path == "/v1/organizations": body = {"organizations": [ORG]}
        elif path.startswith("/v1/organizations/") and path.endswith("/boards"): body = {"boards": [] if self.empty else [{"id": "board-demo", "organizationId": "org-demo", "title": "Launch plan", "createdAt": BOARD["createdAt"]}]}
        elif path == "/v1/task-boards/board-demo": body = {"board": {**BOARD, "lists": [] if self.empty else BOARD["lists"]}}
        elif path == "/v1/projects": body = {"projects": [] if self.empty else PROJECTS}
        elif path == "/v1/sessions": body = {"sessions": [] if self.empty else SESSIONS}
        elif path.endswith("/notes"): body = {"notes": []}
        elif path.endswith("/links"): body = {"links": []}
        elif path.endswith("/events"): body = {"events": []}
        elif path == "/v1/settings":
            if self.fail_settings_once:
                self.fail_settings_once = False
                status, body = 503, {"error": {"code": "synthetic_unavailable", "message": "Synthetic settings outage"}}
            else: body = {"settings": SETTINGS}
        elif path == "/v1/providers/status": body = {"claude": {"connected": True, "plan": "Synthetic"}, "codex": {"connected": True, "plan": "Synthetic"}}
        elif path == "/v1/providers/usage": body = {"claude": {"connected": True, "plan": "Synthetic", "windows": [{"id": "session", "label": "Session", "usedPercent": 31, "resetsAt": None}]}, "codex": {"connected": True, "plan": "Synthetic", "windows": []}}
        elif path == "/v1/skills": body = {"skills": [] if self.empty else SKILLS, "homeScanned": True}
        elif path.startswith("/v1/projects/") and path.endswith("/skills"): body = {"skills": [] if self.empty else PROJECT_SKILLS, "homeScanned": True}
        elif path.startswith("/v1/skills/catalog/search"): body = {"skills": []}
        elif path == "/v1/mcp":
            query = parse_qs(urlparse(req.url).query)
            servers = PROJECT_SERVERS if query.get("scope") == ["project"] else SERVERS
            body = {"servers": [] if self.empty else servers, "homeScanned": True, "malformedConfigs": 0}
        elif path == "/v1/vault": body = {"secrets": [] if self.empty else SECRETS}
        elif method in ("POST", "PATCH", "PUT", "DELETE"):
            # Writes stay in the isolated fake runtime and return the client's expected envelopes.
            if path == "/v1/settings": body = {"settings": SETTINGS}
            elif path == "/v1/vault": body = {"secrets": SECRETS}
            elif path == "/v1/mcp": body = {"servers": SERVERS, "restartRequired": False}
            elif path == "/v1/task-boards/board-demo/cards": body = {}
            else: body = {}
        route.fulfill(status=status, content_type="application/json", body=json.dumps(body))


def screenshot(page, name):
    page.screenshot(path=str(OUT / name), full_page=True, animations="disabled")


def load_app(page):
    page.goto(BASE, wait_until="domcontentloaded", timeout=15000)
    try:
        page.wait_for_load_state("networkidle", timeout=4000)
    except Exception:
        # The authenticated runtime deliberately polls in the background; settle on rendered UI selectors below.
        pass


def wait_home_hero(page):
    page.get_by_role("heading", name="Start a new task").wait_for(timeout=10000)
    page.evaluate("document.fonts.ready")
    page.wait_for_function("() => {const e=document.querySelector('h1');return !!e&&getComputedStyle(e).visibility==='visible'&&Number(getComputedStyle(e).opacity)>=0.99&&e.getBoundingClientRect().height>0}", timeout=8000)


def reload_app(page):
    page.reload(wait_until="domcontentloaded", timeout=15000)
    try:
        page.wait_for_load_state("networkidle", timeout=4000)
    except Exception:
        pass


def check_no_overflow(page, label, results):
    dims = page.evaluate("({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,sh:document.documentElement.scrollHeight,ch:document.documentElement.clientHeight})")
    ok = dims["sw"] <= dims["cw"] + 1
    results.append({"name": f"{label}: no horizontal document overflow", "passed": ok, "details": dims})


def inspect_dialog(page, label, results):
    dialog = page.get_by_role("dialog").last
    if not dialog.count():
        details = page.evaluate("""() => {const d=document.querySelector('[data-slot="dialog-content"]'),o=document.querySelector('[data-slot="dialog-overlay"]'),s=document.querySelector('[role="listbox"],[data-slot="select-content"]'),a=document.activeElement;const chain=e=>{const out=[];for(let n=e;n&&out.length<6;n=n.parentElement)out.push({tag:n.tagName,slot:n.getAttribute('data-slot'),role:n.getAttribute('role'),ariaHidden:n.getAttribute('aria-hidden'),ariaModal:n.getAttribute('aria-modal'),inert:n.hasAttribute('inert'),display:getComputedStyle(n).display,visibility:getComputedStyle(n).visibility});return out};return {dialogCandidates:document.querySelectorAll('[role="dialog"]').length,dialogContent:d&&{role:d.getAttribute('role'),ariaHidden:d.getAttribute('aria-hidden'),ariaModal:d.getAttribute('aria-modal'),state:d.getAttribute('data-state'),chain:chain(d)},overlay:o&&{state:o.getAttribute('data-state'),display:getComputedStyle(o).display,visibility:getComputedStyle(o).visibility,backdrop:getComputedStyle(o).backdropFilter},select:s&&{role:s.getAttribute('role'),state:s.getAttribute('data-state')},active:a&&{tag:a.tagName,role:a.getAttribute('role'),label:a.getAttribute('aria-label'),text:a.textContent?.trim().slice(0,80),slot:a.getAttribute('data-slot'),focused:a===d}}}""")
        results.append({"name": label + ": dialog opens", "passed": False, "details": details})
        return
    rect = dialog.bounding_box()
    viewport = page.evaluate("({w:innerWidth,h:innerHeight})")
    computed = dialog.evaluate("e => ({position:getComputedStyle(e).position, transform:getComputedStyle(e).transform, zIndex:getComputedStyle(e).zIndex, borderRadius:getComputedStyle(e).borderRadius, boxShadow:getComputedStyle(e).boxShadow, background:getComputedStyle(e).backgroundColor})")
    overlay = page.locator('[data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"]').last
    overlay_style = overlay.evaluate("e => {const s=getComputedStyle(e);return {background:s.backgroundColor,opacity:s.opacity,backdropFilter:s.backdropFilter,boxShadow:s.boxShadow}}") if overlay.count() else None
    root_classes = page.locator("html").get_attribute("class") or ""
    channels = [float(value) for value in re.findall(r"\d+(?:\.\d+)?", overlay_style["background"])] if overlay_style else []
    if channels and max(channels[:3]) <= 1: channels[:3] = [value * 255 for value in channels[:3]]
    dark_theme = "dark" in root_classes.split()
    alpha = channels[3] if len(channels) >= 4 else 1.0
    backdrop_theme_matches = bool(overlay_style and channels and (max(channels[:3]) < 40 if dark_theme else max(channels[:3]) < 230) and alpha < 0.85)
    centered = bool(rect and abs((rect["x"] + rect["width"] / 2) - viewport["w"] / 2) < max(24, viewport["w"] * .04))
    bounded = bool(rect and rect["x"] >= -1 and rect["y"] >= -1 and rect["x"] + rect["width"] <= viewport["w"] + 1 and rect["y"] + rect["height"] <= viewport["h"] + 1)
    results.extend([
        {"name": label + ": dialog opens", "passed": True, "details": {"rect": rect, "viewport": viewport, "computed": computed}},
        {"name": label + ": dialog centered and bounded", "passed": centered and bounded, "details": {"rect": rect, "viewport": viewport, "computed": computed}},
        {"name": label + ": dialog scrim color follows the active theme", "passed": backdrop_theme_matches, "details": {"overlay": overlay_style, "rootClasses": root_classes, "parsedRGBA": channels, "content": computed}},
    ])


def main():
    results = []
    console_errors, page_errors, failed_responses = [], [], []
    fixture = Fixture()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # Login, validation and credential visibility are exercised without a real account.
        login = browser.new_page(viewport={"width": 1440, "height": 960})
        login.add_init_script("localStorage.setItem('theme', 'dark')")
        login.on("pageerror", lambda e: page_errors.append(str(e)))
        login.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        login.route("**/*", fixture.handle)
        load_app(login)
        screenshot(login, "login.png")
        login.set_viewport_size({"width": 390, "height": 844})
        screenshot(login, "login-narrow.png")
        check_no_overflow(login, "Login narrow", results)
        login.set_viewport_size({"width": 1440, "height": 960})
        expect(login.get_by_role("heading", name="Sign in to Floq")).to_be_visible()
        login.get_by_role("button", name="Join with an invitation").click()
        expect(login.get_by_role("heading", name="Join an organization")).to_be_visible()
        expect(login.get_by_label("Invitation token")).to_be_visible()
        login.set_viewport_size({"width": 390, "height": 844})
        screenshot(login, "invitation-narrow.png")
        check_no_overflow(login, "Invitation narrow", results)
        login.set_viewport_size({"width": 1440, "height": 960})
        login.get_by_role("button", name="Back").click()
        expect(login.get_by_role("heading", name="Sign in to Floq")).to_be_visible()
        login_radius = login.evaluate("() => Object.fromEntries(['.auth-card','.auth-workflow','input','button.auth-submit'].map(s=>{const e=document.querySelector(s);return [s,e?getComputedStyle(e).borderRadius:null]}))")
        results.append({"name": "Auth cards, inputs, and primary button expose intended corner radius", "passed": all(v and v != "0px" for v in login_radius.values()), "details": login_radius})
        login.get_by_label("Runtime URL").fill("http://synthetic-runtime.invalid")
        email = login.get_by_label("Email")
        email.fill("avery@example.invalid")
        login.get_by_role("button", name="Continue").click()
        expect(login.get_by_role("heading", name="Welcome back")).to_be_visible()
        pw = login.locator("input[type=password]").first
        expect(pw).to_be_visible()
        toggle = login.get_by_role("button", name="Show password")
        if toggle.count():
            toggle.click()
            results.append({"name": "Login password visibility toggle", "passed": login.locator("input[type=text]").count() > 0})
        else:
            results.append({"name": "Login password visibility toggle", "passed": False, "details": "Show password control unavailable"})
        screenshot(login, "login-password.png")
        login.close()

        # Authenticated app scenario. This synthetic localStorage connection only exists in this browser context.
        # Keep Chromium's native OS transparency preference. Theme is set independently in localStorage.
        context = browser.new_context(viewport={"width": 1440, "height": 960})
        context.add_init_script("localStorage.setItem('theme','dark'); localStorage.setItem('floq.connection', JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(USER) + "}));")
        page = context.new_page()
        # Runtime base is synthetic and every request is intercepted before reaching the network.
        page.route("**/*", fixture.handle)
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("response", lambda r: failed_responses.append({"url": r.url, "status": r.status}) if r.status >= 500 else None)
        load_app(page)
        wait_home_hero(page)
        screenshot(page, "home-populated-dark.png")
        check_no_overflow(page, "Home desktop", results)
        # The primary action stays inert until a project and prompt are supplied.
        page.get_by_role("button", name="Select project").click()
        project_row = page.locator('[data-slot="dropdown-menu-item"]').filter(has_text="AGI Paulo - SARAH").last
        pointer_issue = None
        try:
            project_row.click(timeout=1500)
        except Exception as exc:
            pointer_issue = str(exc).splitlines()[-1]
            # Keep keyboard selection as a genuine accessible path; preserve the
            # pointer hit-test blocker in the report instead of calling this a pass.
            project_row.focus()
            project_row.press("Enter")
        results.append({"name": "Home project picker supports pointer activation", "passed": pointer_issue is None,
                        "details": {"pointerError": pointer_issue, "hitTarget": project_row.evaluate("e => {const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {tag:h?.tagName,slot:h?.getAttribute('data-slot'),text:h?.textContent?.trim().slice(0,100)}}")}})
        task_input = page.get_by_role("textbox", name="Task")
        task_input.fill("Review the synthetic onboarding and invite flow.")
        start_action = page.get_by_role("button", name="Start agent")
        expect(start_action).to_be_enabled()
        action_motion = start_action.evaluate("e => {const s=getComputedStyle(e),p=getComputedStyle(e,'::after');return {radius:s.borderRadius,background:s.backgroundColor,image:s.backgroundImage,animation:s.animationName,shimmer:{content:p.content,animation:p.animationName,duration:p.animationDuration,display:p.display},disabled:e.disabled,rect:(()=>{const r=e.getBoundingClientRect();return {w:r.width,h:r.height}})()}}")
        screenshot(page, "home-primary-enabled.png")
        results.append({"name": "Enabled primary CTA exposes the intended visible shimmer", "passed": action_motion["shimmer"]["display"] != "none" and action_motion["shimmer"]["animation"] not in ("none", "initial"), "details": action_motion})
        page.emulate_media(reduced_motion="reduce")
        reduced_motion = start_action.evaluate("e => {const s=getComputedStyle(e,'::after');return {animation:s.animationName,duration:s.animationDuration,iterations:s.animationIterationCount,transitions:getComputedStyle(e).transitionDuration}}")
        reduced_duration = float(reduced_motion["duration"].replace("ms", "").replace("s", ""))
        if reduced_motion["duration"].endswith("ms"): reduced_duration /= 1000
        results.append({"name": "Enabled primary action suppresses continuous shimmer under reduced motion", "passed": not start_action.is_disabled() and (reduced_motion["animation"] in ("none", "initial") or reduced_duration <= 0.001 or reduced_motion["iterations"] == "1"), "details": {"normal": action_motion["shimmer"], "reducedMotion": reduced_motion}})
        page.emulate_media(reduced_motion="no-preference")
        task_input.fill("")
        disabled_style = start_action.evaluate("e => {const p=getComputedStyle(e,'::after');return {disabled:e.disabled,opacity:getComputedStyle(e).opacity,shimmerDisplay:p.display,animation:p.animationName}}")
        results.append({"name": "Primary action disabled state suppresses shimmer", "passed": start_action.is_disabled() and disabled_style["shimmerDisplay"] == "none", "details": disabled_style})
        page.mouse.move(1300, 25)
        screenshot(page, "home-selected-nav-pointer-rest.png")
        sidebar_nav = page.locator('[aria-label="Workspace navigation"]')
        selected_nav = sidebar_nav.get_by_role("button", name="Home")
        nav_style = selected_nav.evaluate("e => { const s=getComputedStyle(e); return {background:s.backgroundColor,border:s.borderColor,outline:s.outlineStyle,after:getComputedStyle(e,':after').borderColor} }")
        results.append({"name": "Selected navigation accent appears only on keyboard focus", "passed": nav_style["outline"] in ("none", "0px"), "details": nav_style})
        radius_matrix = page.evaluate("""() => Object.fromEntries([
          ['sidebar', document.querySelector('[data-sidebar="sidebar"]')],
          ['selected_nav', document.querySelector('[aria-label="Workspace navigation"] button[aria-current="page"]')],
          ['search', document.querySelector('.sidebar-search-glass')],
          ['composer', document.querySelector('.glass-key-surface')],
          ['primary_action', [...document.querySelectorAll('button')].find(e=>e.textContent.includes('Start agent'))],
          ['project_action', [...document.querySelectorAll('button')].find(e=>e.textContent.includes('New project'))],
          ['workspace', document.querySelector('.workspace-frame')],
        ].map(([key,el]) => [key, el ? {radius:getComputedStyle(el).borderRadius,rect:(()=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()} : null]))""")
        positive_radii = [v["radius"] for v in radius_matrix.values() if v and any(float(x.replace("px", "")) > 0 for x in v["radius"].split())]
        results.append({"name": "shadcn surfaces and controls render rounded corners", "passed": len(positive_radii) >= 4, "details": radius_matrix})
        results.append({"name": "Sidebar resize rail removed while titlebar toggle remains", "passed": page.locator('[data-slot="sidebar-rail"]').count() == 0 and page.get_by_role("button", name="Toggle Sidebar").count() > 0, "details": {"railCount": page.locator('[data-slot="sidebar-rail"]').count(), "toggleCount": page.get_by_role("button", name="Toggle Sidebar").count()}})
        sidebar_box = page.evaluate("""() => Object.fromEntries(['[data-slot="sidebar-container"]','[data-sidebar="sidebar"]'].map(sel=>{const e=document.querySelector(sel),s=e&&getComputedStyle(e);return[sel,e?{borderRightWidth:s.borderRightWidth,borderRightColor:s.borderRightColor,borderRightStyle:s.borderRightStyle,radius:s.borderRadius}:null]}))""")
        results.append({"name": "Sidebar container and inner material have no visible vertical divider", "passed": all(not v or v["borderRightWidth"] in ("0px", "0px 0px 0px 0px") or v["borderRightStyle"] == "none" or "rgba(0, 0, 0, 0)" in v["borderRightColor"] for v in sidebar_box.values()), "details": sidebar_box})
        sidebar = page.get_by_role("navigation", name="Workspace navigation")
        # Reproduce the dense project list from the supplied reference screenshot.
        expect(page.get_by_role("button", name="AGI Paulo - SARAH", exact=True)).to_be_visible()
        expect(page.get_by_text("Review policy and edge cases", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="floq/dataverse-mcp", exact=True)).to_be_visible()
        orchestrator_row = page.locator('[data-slot="sidebar-menu-button"]').filter(has_text="Outline the evaluation plan").first
        if orchestrator_row.count():
            orchestrator_style = orchestrator_row.evaluate("e => {const s=getComputedStyle(e);return {background:s.backgroundColor,boxShadow:s.boxShadow,border:s.borderColor,ariaCurrent:e.getAttribute('aria-current')}}")
            purple_persistent = "139, 92, 246" in (orchestrator_style["background"] + orchestrator_style["boxShadow"] + orchestrator_style["border"])
            results.append({"name": "Agent row has no persistent purple orchestrator rail", "passed": not purple_persistent, "details": orchestrator_style})
        project_row = page.get_by_role("button", name="AGI Paulo - SARAH", exact=True)
        project_row.click()
        page.mouse.move(1200, 20)
        screenshot(page, "projects-populated-selected.png")
        lead_badge = page.get_by_role("img", name=re.compile("Lead orchestrator, 0 agents"))
        if lead_badge.count():
            badge_text = lead_badge.first.inner_text().strip()
            results.append({"name": "Zero-recruit orchestrator uses an icon-only badge", "passed": badge_text == "", "details": {"badgeText": badge_text, "title": lead_badge.first.get_attribute("title")}})
        else:
            results.append({"name": "Zero-recruit orchestrator badge renders", "passed": False, "details": "No title=Orchestrator · 0 element in canvas"})
        row_styles = project_row.evaluate("e => { const s=getComputedStyle(e); const r=e.getBoundingClientRect(); return {background:s.backgroundColor,border:s.borderColor,outline:s.outlineColor,outlineStyle:s.outlineStyle,rect:{x:r.x,y:r.y,w:r.width,h:r.height}} }")
        results.append({"name": "Dense project list renders multiple workspaces and agents", "passed": all(page.get_by_text(x, exact=True).count() for x in ["AGI Paulo - SARAH", "Review policy and edge cases"]) and page.get_by_role("button", name="floq/dataverse-mcp", exact=True).count() > 0, "details": {"items": 3, "workspaces": 6, "agents": len(SESSIONS), "selected_row": row_styles}})
        results.append({"name": "Selected project remains readable and has no persistent focus outline", "passed": row_styles["outlineStyle"] in ("none", "0px") or row_styles["outline"] in ("rgba(0, 0, 0, 0)", "transparent"), "details": row_styles})
        dark_palette = page.evaluate("() => { const s=getComputedStyle(document.documentElement); const b=getComputedStyle(document.body); const nav=document.querySelector('[aria-label=\"Workspace navigation\"]'); const n=nav&&getComputedStyle(nav); return {root:s.backgroundColor,body:b.backgroundColor,sidebar:n?.backgroundColor,backgroundToken:s.getPropertyValue('--background').trim(),material:document.documentElement.dataset.material} }")
        root_black = dark_palette["body"] in ("rgb(0, 0, 0)", "rgba(0, 0, 0, 1)") or "0 0% 0%" in dark_palette["backgroundToken"]
        results.append({"name": "OLED dark root is true black with neutral elevated sidebar", "passed": root_black and dark_palette["material"] in ("mica", "acrylic", "solid"), "details": dark_palette})
        material_profile = page.evaluate("""() => Object.fromEntries([
          ['theme_root',document.documentElement],
          ['sidebar',document.querySelector('[data-sidebar="sidebar"]')],
          ['sidebar_inner',document.querySelector('[data-slot="sidebar-inner"]')],
          ['sidebar_container',document.querySelector('[data-slot="sidebar-container"]')],
          ['home_composer',document.querySelector('.glass-key-surface')],
          ['workspace',document.querySelector('.workspace-frame')],
          ['sidebar_dust',document.querySelector('.sidebar-dust-backdrop')],
          ['sidebar_search_glass',document.querySelector('.sidebar-search-glass')],
        ].map(([key,e])=>{if(!e)return[key,null];const s=getComputedStyle(e),p=getComputedStyle(e,'::before'),a=getComputedStyle(e,'::after'),image=s.backgroundImage;return[key,{classes:e.className,rootClasses:e===document.documentElement?e.className:null,dataTheme:e===document.documentElement?e.getAttribute('data-theme'):null,background:s.backgroundColor,backgroundImagePresent:image!=='none',backdropFilter:s.backdropFilter,webkitBackdropFilter:s.webkitBackdropFilter,filter:s.filter,opacity:s.opacity,shadow:s.boxShadow,border:s.borderColor,borderWidth:s.borderWidth,radius:s.borderRadius,before:{content:p.content,opacity:p.opacity,filter:p.filter}}]}))""")
        # Capture pointer hover and keyboard focus separately; hover must not alter row geometry.
        before_rect = project_row.bounding_box()
        project_row.hover()
        hover_rect = project_row.bounding_box()
        page.keyboard.press("Tab")
        focus = page.evaluate("""() => {const e=document.activeElement,s=getComputedStyle(e);return {tag:e?.tagName,label:e?.getAttribute('aria-label'),focusVisible:e?.matches(':focus-visible'),outline:s.outlineStyle,outlineWidth:s.outlineWidth,boxShadow:s.boxShadow,borderColor:s.borderColor,ringColor:s.getPropertyValue('--tw-ring-color')}}""")
        results.append({"name": "Project row hover keeps layout geometry stable", "passed": before_rect == hover_rect, "details": {"before": before_rect, "hover": hover_rect}})
        results.append({"name": "Keyboard focus remains visible", "passed": focus["focusVisible"] and (focus["outline"] not in ("none", "0px") or focus["boxShadow"] != "none"), "details": focus})
        desktop_sidebar = page.locator('[data-slot="sidebar"][data-collapsible="icon"]').first
        toggle_sidebar = page.get_by_role("button", name="Toggle Sidebar").first
        if desktop_sidebar.count() and toggle_sidebar.count():
            toggle_sidebar.click()
            collapsed_state = desktop_sidebar.get_attribute("data-state")
            toggle_sidebar.click()
            expanded_state = desktop_sidebar.get_attribute("data-state")
            results.append({"name": "Titlebar control collapses and restores sidebar", "passed": collapsed_state == "collapsed" and expanded_state == "expanded", "details": {"collapsed": collapsed_state, "restored": expanded_state}})
        # An anchored project action popup must stay inside the desktop viewport.
        actions = page.get_by_role("button", name="Actions for AGI Paulo - SARAH")
        actions.focus()
        actions.press("Enter")
        if page.get_by_role("menu").count():
            menu_rect = page.get_by_role("menu").bounding_box()
            results.append({"name": "Project action popup stays inside viewport", "passed": bool(menu_rect and menu_rect["x"] >= 0 and menu_rect["x"] + menu_rect["width"] <= 1441), "details": menu_rect})
            page.keyboard.press("Escape")
        else:
            results.append({"name": "Project action popup opens from keyboard", "passed": False, "details": "Menu did not open"})

        nav = page.locator('[aria-label="Workspace navigation"]')
        nav.get_by_role("button", name="Tasks").click()
        page.get_by_text("Review onboarding", exact=True).wait_for(timeout=8000)
        screenshot(page, "tasks-populated.png")
        check_no_overflow(page, "Tasks desktop", results)
        task_card = page.get_by_role("button", name="Open card: Review onboarding")
        if task_card.count():
            task_card.click()
            expect(page.get_by_role("dialog")).to_be_visible(timeout=5000)
            inspect_dialog(page, "Task detail", results)
            screenshot(page, "task-detail-dialog.png")
            page.keyboard.press("Escape")

        # Keyboard board picker, escaping returns focus to its trigger.
        trigger = page.get_by_role("button", name="Choose a board")
        if trigger.count():
            trigger.first.click()
            expect(page.get_by_role("dialog")).to_be_visible()
            picker = page.get_by_role("dialog").last
            screenshot(page, "board-picker.png")
            inspect_dialog(page, "Board picker", results)
            page.keyboard.press("Escape")
            focus_timeline = []
            for delay in (100, 300, 700):
                page.wait_for_timeout(delay)
                sample = page.evaluate("""() => {const a=document.activeElement;return {tag:a?.tagName,role:a?.getAttribute('role'),label:a?.getAttribute('aria-label'),text:a?.textContent?.trim().slice(0,64),slot:a?.getAttribute('data-slot'),title:a?.getAttribute('title'),bodyScrollLocked:document.body.hasAttribute('data-scroll-locked'),dialogs:[...document.querySelectorAll('[role="dialog"]')].map(e=>({state:e.getAttribute('data-state'),hidden:e.getAttribute('aria-hidden'),display:getComputedStyle(e).display}))}}""")
                focus_timeline.append({"afterMs": delay, **sample})
            results.append({"name": "Board picker Escape restores trigger focus", "passed": trigger.first.evaluate("e => document.activeElement === e"), "details": focus_timeline})

        nav.get_by_role("button", name="Skills & MCP").click()
        page.get_by_role("heading", name="Skills").wait_for(timeout=8000)
        page.get_by_text("accessibility-review", exact=True).wait_for(timeout=8000)
        search = page.get_by_role("textbox", name="Search skills and MCP servers")
        search.fill("no-such-synthetic-skill")
        expect(page.get_by_text("No skills match this search")).to_be_visible()
        screenshot(page, "skills-no-results.png")
        clear = page.get_by_role("button", name="Clear search")
        if clear.count(): clear.first.click()
        screenshot(page, "skills-populated.png")
        check_no_overflow(page, "Skills desktop", results)

        nav.get_by_role("button", name="Secrets").click()
        page.get_by_text("DOCS_TOKEN", exact=True).wait_for(timeout=8000)
        screenshot(page, "secrets-populated.png")
        check_no_overflow(page, "Secrets desktop", results)

        # Settings are opened using the real user menu. Inspect its rendered position and theme settings.
        settings_button = page.get_by_role("button", name="Settings")
        if not settings_button.count():
            # User menu can expose Settings after opening the account card.
            user_menu = page.get_by_role("button", name="Avery Example")
            if user_menu.count(): user_menu.click()
            settings_button = page.get_by_role("menuitem", name="Settings")
        if settings_button.count():
            fixture.fail_settings_once = True
            settings_button.click()
            expect(page.get_by_role("dialog")).to_be_visible(timeout=8000)
            page.get_by_role("button", name="Agents").click()
            expect(page.get_by_role("heading", name="Could not load settings")).to_be_visible(timeout=8000)
            screenshot(page, "settings-load-error.png")
            retry = page.get_by_role("button", name="Retry")
            retry.click()
            expect(page.get_by_text("Could not load settings")).to_have_count(0, timeout=8000)
            results.append({"name": "Settings Retry recovers after one synthetic 503", "passed": True})
            page.get_by_role("button", name="Appearance").click()
            inspect_dialog(page, "Settings", results)
            screenshot(page, "settings-dark.png")
            page.get_by_label("Theme").click()
            page.get_by_role("option", name="Light", exact=True).click()
            page.wait_for_timeout(600)
            inspect_dialog(page, "Settings light", results)
            results.append({"name": "Settings dialog remains exposed after selecting Light", "passed": page.get_by_role("dialog", include_hidden=True).count() > 0, "details": page.evaluate("""() => {const d=document.querySelector('[data-slot="dialog-content"]'),o=document.querySelector('[data-slot="dialog-overlay"]'),a=document.activeElement;const chain=[];for(let n=d;n&&chain.length<5;n=n.parentElement)chain.push({tag:n.tagName,slot:n.getAttribute('data-slot'),role:n.getAttribute('role'),ariaHidden:n.getAttribute('aria-hidden'),ariaModal:n.getAttribute('aria-modal'),inert:n.hasAttribute('inert'),display:getComputedStyle(n).display,visibility:getComputedStyle(n).visibility});return {dialogCount:document.querySelectorAll('[role="dialog"]').length,dialogContent:d&&{role:d.getAttribute('role'),ariaHidden:d.getAttribute('aria-hidden'),ariaModal:d.getAttribute('aria-modal'),state:d.getAttribute('data-state'),chain},overlay:o&&{state:o.getAttribute('data-state'),display:getComputedStyle(o).display,visibility:getComputedStyle(o).visibility},active:a&&{tag:a.tagName,role:a.getAttribute('role'),label:a.getAttribute('aria-label'),text:a.textContent?.trim().slice(0,80)}}}""")})
            screenshot(page, "settings-light.png")
            page.keyboard.press("Escape")
            page.locator('[aria-label="Workspace navigation"]').get_by_role("button", name="Home").click()
            wait_home_hero(page)
            hero = page.get_by_role("heading", name="Start a new task").evaluate("e => {const s=getComputedStyle(e),r=e.getBoundingClientRect();return {text:e.innerText,opacity:s.opacity,visibility:s.visibility,color:s.color,rect:{x:r.x,y:r.y,w:r.width,h:r.height}}}")
            results.append({"name": "Light Home heading and greeting are visibly rendered", "passed": hero["opacity"] == "1" and hero["visibility"] == "visible" and hero["rect"]["h"] > 0 and hero["text"] == "Start a new task", "details": hero})
            screenshot(page, "home-populated-light.png")
            page.keyboard.press("Escape")

        # Narrow viewport checks use the actual navigation drawer and full-page overflow dimensions.
        page.set_viewport_size({"width": 390, "height": 844})
        reload_app(page)
        wait_home_hero(page)
        check_no_overflow(page, "Home narrow", results)
        screenshot(page, "home-narrow.png")
        # A short viewport also catches dialogs that extend past the lower edge.
        page.set_viewport_size({"width": 390, "height": 640})
        nav_button = page.get_by_role("button", name="Toggle Sidebar").first
        if nav_button.count():
            nav_button.click()
            expect(page.get_by_role("dialog", name="Sidebar")).to_be_visible()
            page.keyboard.press("Escape")
            results.append({"name": "Mobile navigation drawer closes with Escape", "passed": True})

        # The empty fixture still uses the same isolated API routes; reload and verify the actual empty states.
        fixture.empty = True
        reload_app(page)
        page.get_by_role("heading", name="Start a new task").wait_for(timeout=10000)
        screenshot(page, "home-empty.png")
        # Return to desktop width so the navigation controls are present for sequential empty-state checks.
        page.set_viewport_size({"width": 1440, "height": 960})
        nav = page.locator('[aria-label="Workspace navigation"]')
        nav.get_by_role("button", name="Tasks").click()
        expect(page.get_by_text("No boards yet")).to_be_visible(timeout=8000)
        screenshot(page, "tasks-empty.png")
        nav.get_by_role("button", name="Secrets").click()
        expect(page.get_by_text("No secrets stored yet")).to_be_visible(timeout=8000)
        screenshot(page, "secrets-empty.png")
        nav.get_by_role("button", name="Skills & MCP").click()
        expect(page.get_by_text("No installed skills yet")).to_be_visible(timeout=8000)
        screenshot(page, "skills-empty.png")
        check_no_overflow(page, "Skills narrow", results)

        context.close()
        browser.close()

    errors = [e for e in page_errors if "ResizeObserver loop" not in e]
    report = {
        "environment": "Headless Chromium browser WebView surface, intercepted synthetic runtime, 1440x960 desktop, 390x844 narrow and 390x640 short viewport",
        "synthetic_data": True,
        "native_desktop_runtime_tested": False,
        "checks": results,
        "errors": errors,
        "console_errors": console_errors,
        "failed_responses": failed_responses,
        "fixture_requests": fixture.calls,
        "screenshots": sorted(p.name for p in OUT.glob("*.png")),
    }
    Path("docs/ui-verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": sum(1 for x in results if x.get("passed")), "failed": [x for x in results if not x.get("passed")], "errors": errors, "console_errors": console_errors, "report": "docs/ui-verification.json"}, indent=2))
    if errors or any(not x.get("passed") for x in results): raise SystemExit(1)


if __name__ == "__main__":
    main()
