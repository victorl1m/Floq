"""Organization flows on a stateful synthetic runtime (dev server on :1420, or PROBE_URL):
account-menu switcher with checkmark, create-organization dialog (slug preview + availability), invite flow in
Settings > Organization (owner), pending-invitation badge/toast and accept via the inbox. Dark and light screenshots."""
import importlib.util, json, os, re, sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
def load(n, f):
    s = importlib.util.spec_from_file_location(n, ROOT / "scripts" / f); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
FIX = load("verify_ui", "verify-ui.py")
OUT = ROOT / "docs" / "redesign" / "organizations"; OUT.mkdir(parents=True, exist_ok=True)
URL = os.environ.get("PROBE_URL", os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1420/"))
ME = FIX.USER["id"]
def member(uid, name, email, role): return {"id": uid, "name": name, "email": email, "role": role}
def jr(route, body, status=200): route.fulfill(status=status, content_type="application/json", body=json.dumps(body))

class Fx(FIX.Fixture):
    def __init__(self):
        super().__init__()
        self.orgs = [{"id": "org-demo", "name": "Studio North", "slug": "studio-north", "role": "owner", "createdAt": "2026-01-01T00:00:00Z", "members": [
            member(ME, FIX.USER["name"], FIX.USER["email"], "owner"), member("u-2", "Sam Rivera", "sam@example.invalid", "admin"), member("u-3", "Kai Lee", "kai@example.invalid", "member")]}]
        self.invites = {"org-demo": []}
        self.incoming = [{"id": "inc-1", "organization": {"id": "org-north", "name": "Northwind", "slug": "northwind"}, "role": "member", "invitedBy": "Sam Rivera", "expiresAt": "2099-01-01T00:00:00Z"}]
        self.posts = []
    def handle(self, route):
        req = route.request; path = urlparse(req.url).path; m = req.method
        if not path.startswith("/v1/"): return super().handle(route)
        body = json.loads(req.post_data or "{}") if req.post_data else {}
        if path == "/v1/organizations" and m == "GET": return jr(route, {"organizations": self.orgs})
        if path == "/v1/organizations" and m == "POST":
            self.posts.append((path, body))
            org = {"id": "org-new", "name": body["name"], "slug": body["slug"], "role": "owner", "createdAt": "2026-02-01T00:00:00Z", "members": [member(ME, FIX.USER["name"], FIX.USER["email"], "owner")]}
            self.orgs.append(org); self.invites["org-new"] = []
            return jr(route, {"organization": org}, 201)
        s = re.fullmatch(r"/v1/organization-slugs/([^/]+)", path)
        if s: return jr(route, {"slug": s.group(1), "available": s.group(1) not in ("taken", "studio-north")})
        if path == "/v1/me/organization-invitations": return jr(route, {"invitations": self.incoming})
        a = re.fullmatch(r"/v1/organization-invitations/([^/]+)/(accept|decline)", path)
        if a and m == "POST":
            self.posts.append((path, body)); inv = next(i for i in self.incoming if i["id"] == a.group(1)); self.incoming.remove(inv)
            if a.group(2) == "accept":
                self.orgs.append({"id": inv["organization"]["id"], "name": inv["organization"]["name"], "slug": inv["organization"]["slug"], "role": inv["role"], "members": [member("u-2", "Sam Rivera", "sam@example.invalid", "owner"), member(ME, FIX.USER["name"], FIX.USER["email"], inv["role"])]})
            return jr(route, {"organizationId": inv["organization"]["id"]})
        i = re.fullmatch(r"/v1/organizations/([^/]+)/invitations(?:/([^/]+))?", path)
        if i:
            lst = self.invites.setdefault(i.group(1), [])
            if m == "GET": return jr(route, {"invitations": lst})
            if m == "POST":
                self.posts.append((path, body))
                inv = {"id": f"inv-{len(lst)+1}", "email": body["email"], "role": body["role"], "invitedBy": FIX.USER["name"], "createdAt": "2026-02-01T00:00:00Z", "expiresAt": "2099-01-01T00:00:00Z", "status": "pending"}
                lst.append(inv); return jr(route, {"invitation": {**inv, "token": "tok_SYNTHETIC_ONE_TIME_CODE", "delivery": "manual"}}, 201)
            if m == "DELETE":
                self.posts.append((path, {})); self.invites[i.group(1)] = [x for x in lst if x["id"] != i.group(2)]; return jr(route, {"ok": True})
        return super().handle(route)

res = {}
def check(name, ok, info=""):
    res[name] = bool(ok); print(("PASS " if ok else "FAIL ") + name, info)

def run(p, theme):
    b = p.chromium.launch(headless=True); ctx = b.new_context(viewport={"width": 1440, "height": 960})
    ctx.add_init_script("localStorage.setItem('theme','" + theme + "');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIX.USER) + "}));")
    page = ctx.new_page(); fx = Fx(); page.route("**/*", fx.handle)
    page.goto(URL, wait_until="domcontentloaded", timeout=15000); page.wait_for_selector('[data-slot="sidebar-inner"]', timeout=20000); page.wait_for_timeout(1500)
    toasts = page.evaluate("()=>[...document.querySelectorAll('[data-sonner-toast]')].map(t=>t.innerText)")
    check("toast announces new invitation", any("Northwind" in t for t in toasts), toasts)
    check("account menu badge shows pending invitation", page.get_by_role("img", name=re.compile("1 pending organization invitation")).count() == 1)
    page.screenshot(path=str(OUT / f"toast-badge-{theme}.png"))

    # Switcher: Organization submenu lists orgs with a checked active one and the create action.
    page.get_by_role("button", name=re.compile("Avery Example")).first.click()
    page.get_by_role("menuitem", name=re.compile("Studio North")).first.hover(); page.wait_for_timeout(250)
    checked = page.get_by_role("menuitemradio", name="Studio North")
    check("active organization is checked", checked.get_attribute("aria-checked") == "true")
    check("create + settings + pending items present", all(page.get_by_role("menuitem", name=n).count() >= 1 for n in ("Create organization", "Organization settings", re.compile("Pending invitations"))))
    page.screenshot(path=str(OUT / f"switcher-{theme}.png"))

    # Create dialog.
    page.get_by_role("menuitem", name="Create organization").click(); dlg = page.get_by_role("dialog", name="Create organization"); dlg.wait_for(timeout=3000)
    create_btn = dlg.get_by_role("button", name="Create organization")
    check("create disabled while empty", create_btn.is_disabled())
    page.wait_for_timeout(400)
    check("name field focused", page.evaluate("()=>document.activeElement?.tagName==='INPUT' && document.activeElement?.placeholder==='Acme Studio'"), page.evaluate("()=>document.activeElement?.outerHTML.slice(0,80)"))
    dlg.get_by_label("Name", exact=True).fill("Taken"); page.wait_for_timeout(700)
    check("taken slug blocks create", create_btn.is_disabled() and "taken" in dlg.get_by_role("status").inner_text().lower(), dlg.get_by_role("status").inner_text())
    dlg.get_by_label("Name", exact=True).fill("Acme Studio"); page.wait_for_timeout(700)
    check("slug preview follows name", dlg.get_by_label("URL name").input_value() == "acme-studio")
    check("availability announced", "Available" in dlg.get_by_role("status").inner_text())
    page.screenshot(path=str(OUT / f"create-{theme}.png"))
    create_btn.click(); page.wait_for_timeout(900)
    check("POST create sent name+slug", fx.posts[:1] == [("/v1/organizations", {"name": "Acme Studio", "slug": "acme-studio"})], fx.posts)
    check("dialog closed and new org active", page.get_by_role("dialog", name="Create organization").count() == 0 and page.get_by_role("button", name=re.compile("Avery Example")).first.inner_text().count("Acme Studio") == 1)

    # Settings > Organization (switch back to Studio North, owner).
    page.get_by_role("button", name=re.compile("Avery Example")).first.click(); page.get_by_role("menuitem", name=re.compile("Acme Studio")).first.hover(); page.wait_for_timeout(250)
    page.get_by_role("menuitemradio", name="Studio North").click(); page.wait_for_timeout(300)
    page.get_by_role("button", name=re.compile("Avery Example")).first.click(); page.get_by_role("menuitem", name=re.compile("Studio North")).first.hover(); page.wait_for_timeout(250)
    page.get_by_role("menuitem", name="Organization settings").click(); page.wait_for_timeout(600)
    sd = page.get_by_role("dialog").first
    check("members table lists everyone", sd.get_by_role("table").locator("tbody tr").count() == 3)
    check("role select for non-owner members", sd.get_by_label("Role for Sam Rivera").count() == 1 and sd.get_by_label("Role for Kai Lee").count() == 1)
    sd.get_by_label("Invite by email").fill("new.person@example.invalid"); sd.get_by_role("button", name="Invite").click(); page.wait_for_timeout(700)
    check("invite POST has email+role", fx.posts[-1] == ("/v1/organizations/org-demo/invitations", {"email": "new.person@example.invalid", "role": "member"}), fx.posts[-1])
    check("one-time code shown and delivery stated manual", sd.get_by_text("tok_SYNTHETIC_ONE_TIME_CODE").count() == 1 and sd.get_by_text("Floq does not send email", exact=False).count() == 1)
    check("pending list shows invitee", sd.get_by_text("new.person@example.invalid").count() >= 1)
    sd.get_by_text("Pending invitations").count()
    page.screenshot(path=str(OUT / f"settings-invites-{theme}.png"))
    sd.get_by_role("button", name="Cancel invitation to new.person@example.invalid").click(); page.wait_for_timeout(600)
    check("cancel removes pending", sd.get_by_text("No pending invitations").count() == 1)
    sd.get_by_role("button", name="Delete organization").click(); page.wait_for_timeout(300)
    ad = page.get_by_role("alertdialog"); action = ad.get_by_role("button", name="Delete organization")
    check("delete needs typed name", action.is_disabled())
    ad.get_by_label(re.compile("Type")).fill("Studio North"); check("delete enabled after typing name", action.is_enabled())
    page.screenshot(path=str(OUT / f"delete-confirm-{theme}.png")); page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)

    # Accept the pending invitation from the inbox.
    page.get_by_role("button", name=re.compile("Avery Example")).first.click(); page.get_by_role("menuitem", name=re.compile("Studio North")).first.hover(); page.wait_for_timeout(250)
    page.get_by_role("menuitem", name=re.compile("Pending invitations")).click(); idlg = page.get_by_role("dialog", name="Pending invitations"); idlg.wait_for(timeout=3000)
    page.screenshot(path=str(OUT / f"inbox-{theme}.png"))
    idlg.get_by_role("button", name="Accept invitation to Northwind").click(); page.wait_for_timeout(900)
    check("accept POST sent", fx.posts[-1][0] == "/v1/organization-invitations/inc-1/accept", fx.posts[-1])
    check("inbox closes and Northwind becomes active", page.get_by_role("dialog", name="Pending invitations").count() == 0 and "Northwind" in page.get_by_role("button", name=re.compile("Avery Example")).first.inner_text())
    check("badge cleared", page.get_by_role("img", name=re.compile("pending organization invitation")).count() == 0)
    b.close()

with sync_playwright() as p:
    for th in ("dark", "light"): print("==", th); run(p, th)
print(json.dumps(res)); sys.exit(0 if all(res.values()) else 1)
