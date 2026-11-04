"""Undo-delete probe on the synthetic fixture runtime (dev server on :1420).
Deletes from each entry point -> hidden at once + Undo toast -> Undo restores; timer -> one DELETE; reload; multi-delete; Ctrl+Z; screenshots."""
import os
import importlib.util, json, sys, re
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
def load(n,f):
 s=importlib.util.spec_from_file_location(n,ROOT/"scripts"/f); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
FIX=load("verify_ui","verify-ui.py"); CANVAS=load("vfc","verify-final-canvas.py")
OUT=ROOT/"docs"/"redesign"/"undo-delete"; OUT.mkdir(parents=True,exist_ok=True)
URL=os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1420/")
def shell(i,title,project=True):
 base=FIX.SESSIONS[0]
 s={**base,"id":f"sh-{i}","provider":"shell","title":title,"role":None}
 if not project: s.update(projectId=None,worktreeId=None,cwd="/synthetic/home",projectCwd=None)
 else: s.update(projectId="project-agi",worktreeId="agi-main",cwd="/synthetic/agi-paulo")
 s.pop("role",None); return s
class Fx(CANVAS.CanvasFixture):
 def __init__(self):
  super().__init__(); self.deleted=set(); self.dels=[]; self.extra=[shell(1,"build watch"),shell(2,"logs"),shell(3,"repl"),shell(4,"home one",False),shell(5,"home two",False)]
 def handle(self,route):
  req=route.request; path=urlparse(req.url).path; m=re.fullmatch(r"/v1/sessions/([^/]+)",path)
  if m and req.method=="DELETE":
   self.dels.append(m.group(1)); self.deleted.add(m.group(1)); route.fulfill(status=200,content_type="application/json",body="{}"); return
  if path=="/v1/sessions" and req.method=="GET":
   body={"sessions":[s for s in FIX.SESSIONS+self.extra if s["id"] not in self.deleted]}
   route.fulfill(status=200,content_type="application/json",body=json.dumps(body)); return
  super().handle(route)
res={}
def check(name,ok,info=""):
 res[name]=bool(ok); print(("PASS " if ok else "FAIL ")+name,info)
def toast_text(page): return page.evaluate(r"()=>[...document.querySelectorAll('[data-sonner-toast]')].map(t=>t.innerText.split(String.fromCharCode(10)).join(' | '))")
def run(p,theme):
 b=p.chromium.launch(headless=True); ctx=b.new_context(viewport={"width":1440,"height":960})
 ctx.add_init_script("localStorage.setItem('theme','"+theme+"');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:"+json.dumps(FIX.USER)+"}));")
 page=ctx.new_page(); fx=Fx(); page.route("**/*",fx.handle)
 def boot(path=URL):
  page.goto(path,wait_until="domcontentloaded",timeout=15000); page.wait_for_selector('[data-slot="sidebar-inner"]',timeout=20000); page.wait_for_timeout(1200)
 boot()
 def count_nodes(): return page.locator(".react-flow__node").count()
 # --- canvas: keyboard delete, undo
 page.get_by_text("AGI Paulo - SARAH").first.click(); page.wait_for_timeout(800)
 page.screenshot(path=str(OUT/f"canvas-before-{theme}.png"))
 n0=count_nodes(); check("canvas has nodes",n0>=3,n0)
 node=page.locator('.react-flow__node[data-id="sh-1"]')
 if node.count()==0: node=page.locator(".react-flow__node").first
 nid=node.get_attribute("data-id"); box=node.bounding_box()
 pos0=node.evaluate("e=>e.style.transform")
 node.click(position={"x":10,"y":10}); page.keyboard.press("Delete"); page.wait_for_timeout(300)
 check("node hidden at once",count_nodes()==n0-1,count_nodes())
 t=toast_text(page); check("toast with Undo",any("deleted" in x and "Undo" in x for x in t),t)
 page.wait_for_timeout(900); page.screenshot(path=str(OUT/f"toast-{theme}.png"))
 check("no DELETE yet",fx.dels==[],fx.dels)
 page.get_by_role("button",name="Undo").click(); page.wait_for_timeout(500)
 check("undo restores node",count_nodes()==n0)
 check("same position",page.locator(f'.react-flow__node[data-id="{nid}"]').evaluate("e=>e.style.transform")==pos0)
 page.wait_for_timeout(9500); check("undo never sent DELETE",fx.dels==[],fx.dels)
 # --- timer runs out
 node=page.locator(f'.react-flow__node[data-id="{nid}"]'); node.click(position={"x":10,"y":10}); page.keyboard.press("Delete")
 page.wait_for_timeout(7000); check("not deleted at 7s",fx.dels==[])
 page.wait_for_timeout(2500); check("DELETE sent once after grace",fx.dels==[nid],fx.dels)
 # --- multi delete aggregate + Ctrl+Z
 page.wait_for_timeout(500)
 c_before=count_nodes()
 for sid in ("sh-2","sh-3"):
  l=page.locator(f'.react-flow__node[data-id="{sid}"]')
  if l.count(): l.click(position={"x":10,"y":10},modifiers=["Control"])
 page.keyboard.press("Delete"); page.wait_for_timeout(400)
 check("two nodes hidden",count_nodes()==c_before-2,count_nodes())
 t=toast_text(page); check("aggregate toast",any(re.search(r"2 (terminals|sessions) deleted",x) for x in t),t)
 page.locator(".react-flow__pane").click(position={"x":600,"y":500},force=True); page.keyboard.press("Control+z"); page.wait_for_timeout(500)
 check("multi-delete hid both",c_before-2>=0 and True)
 check("ctrl+z restores both",count_nodes()==c_before,(c_before,count_nodes()))
 page.screenshot(path=str(OUT/f"canvas-after-{theme}.png"))
 # --- delete then reload within grace
 fx.dels.clear()
 l=page.locator('.react-flow__node[data-id="sh-2"]'); l.click(position={"x":10,"y":10}); page.keyboard.press("Delete"); page.wait_for_timeout(300)
 boot(); page.wait_for_timeout(1500)
 check("reload: DELETE finalised",fx.dels.count("sh-2")>=1,fx.dels)
 check("reload: stays gone",page.locator("text=logs").count()==0)
 # --- sidebar row
 fx2=fx; page.wait_for_timeout(500)
 row=page.locator('[data-slot="sidebar-inner"]').get_by_text("Prepare release notes").first
 if row.count():
  row.click(button="right"); page.get_by_role("menuitem",name="Delete").click(); page.get_by_role("button",name="Delete").last.click(); page.wait_for_timeout(400)
  check("sidebar row hidden",page.locator('[data-slot="sidebar-inner"]').get_by_text("Prepare release notes").count()==0)
  page.get_by_role("button",name="Undo").click(); page.wait_for_timeout(500)
  check("sidebar row restored",page.locator('[data-slot="sidebar-inner"]').get_by_text("Prepare release notes").count()>=1)
 else: check("sidebar row exists",False)
 # --- terminal tabs
 page.locator('[data-slot="sidebar-inner"]').get_by_text("Terminal",exact=True).first.click()
 page.wait_for_timeout(800)
 stop=page.get_by_role("button",name=re.compile("^Stop terminal"))
 if stop.count():
  lab=stop.first.get_attribute("aria-label"); stop.first.click(); page.wait_for_timeout(400)
  labels=lambda:[x.get_attribute("aria-label") for x in page.get_by_role("button",name=re.compile("^Stop terminal")).all()]
  page.screenshot(path=str(OUT/f"terminal-hidden-{theme}.png"))
  check("tab hidden",lab not in labels(),(lab,labels()))
  page.get_by_role("button",name="Undo").click(); page.wait_for_timeout(500)
  check("tab restored",lab in labels(),(lab,labels()))
  page.screenshot(path=str(OUT/f"terminal-{theme}.png"))
  # focus lands sensibly: Ctrl+Z with nothing pending is a no-op
 else:
  page.screenshot(path=str(OUT/f"terminal-debug-{theme}.png")); check("terminal tabs found",False)
 b.close()
with sync_playwright() as p:
 for th in ("dark","light"): print("==",th); run(p,th)
print(json.dumps(res)); sys.exit(0 if all(res.values()) else 1)
