"""Note title probe on the synthetic fixture runtime (dev server on :1420): context menu has no colour items,
double-click/F2 title editing, Enter/blur save, Escape cancel, empty clears, typing never drags the node."""
import importlib.util, json, sys, re
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
def load(n,f):
 s=importlib.util.spec_from_file_location(n,ROOT/"scripts"/f); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
FIX=load("verify_ui","verify-ui.py"); CANVAS=load("vfc","verify-final-canvas.py")
OUT=ROOT/"docs"/"redesign"/"note-title"; OUT.mkdir(parents=True,exist_ok=True)
URL="http://127.0.0.1:1420/"
def note(i,**kw):
 return {"id":f"n{i}","projectId":"project-agi","text":"hello","color":"yellow","x":60+i*10,"y":420,"w":240,"h":160,"linkedSessionIds":[],"title":None,"agentNoteName":None,"placed":True,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z",**kw}
class Fx(CANVAS.CanvasFixture):
 def __init__(self):
  super().__init__(); self.notes=[note(1,x=-400,y=-500),note(2,x=-100,y=-500,title="agent-plan",agentNoteName="agent-plan")]; self.patches=[]
 def handle(self,route):
  req=route.request; path=urlparse(req.url).path
  if path=="/v1/projects/project-agi/notes" and req.method=="GET":
   route.fulfill(status=200,content_type="application/json",body=json.dumps({"notes":self.notes})); return
  m=re.fullmatch(r"/v1/notes/([^/]+)",path)
  if m and req.method=="PATCH":
   body=json.loads(req.post_data or "{}"); self.patches.append((m.group(1),body))
   n=next(x for x in self.notes if x["id"]==m.group(1))
   if body.get("title")=="taken": route.fulfill(status=409,content_type="application/json",body=json.dumps({"error":{"code":"duplicate_note","message":"A note named taken already exists"}})); return
   n.update(body); n["updatedAt"]="2026-01-02T00:00:00Z"
   if "title" in body and n["agentNoteName"]: n["agentNoteName"]=body["title"]
   route.fulfill(status=200,content_type="application/json",body=json.dumps(n)); return
  super().handle(route)
res={}
def check(name,ok,info=""):
 res[name]=bool(ok); print(("PASS " if ok else "FAIL ")+name,info)
def run(p,theme):
 b=p.chromium.launch(headless=True); ctx=b.new_context(viewport={"width":1440,"height":960})
 ctx.add_init_script("localStorage.setItem('theme','"+theme+"');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:"+json.dumps(FIX.USER)+"}));")
 page=ctx.new_page(); fx=Fx(); page.route("**/*",fx.handle)
 page.goto(URL,wait_until="domcontentloaded",timeout=15000); page.wait_for_selector('[data-slot="sidebar-inner"]',timeout=20000); page.wait_for_timeout(1000)
 page.get_by_text("AGI Paulo - SARAH").first.click(); page.wait_for_timeout(1500)
 n1=page.locator('.react-flow__node[data-id="note:n1"]'); n2=page.locator('.react-flow__node[data-id="note:n2"]')
 page.get_by_role("button",name="Show all notes").click(); page.wait_for_timeout(600)
 check("notes render",n1.count()==1 and n2.count()==1)
 # context menu
 n1.locator(".note-drag").click(button="right",position={"x":150,"y":14}); page.wait_for_timeout(300)
 items=page.get_by_role("menuitem").all_inner_texts()
 check("menu has no colour items",not any("Color" in t or t.strip() in ("Yellow","Blue","Green","Pink","Purple","Gray") for t in items),items)
 check("menu keeps delete",any("Delete note" in t for t in items),items)
 page.screenshot(path=str(OUT/f"menu-{theme}.png")); page.keyboard.press("Escape"); page.wait_for_timeout(200)
 # double-click header -> editor
 tr0=n1.evaluate("e=>e.style.transform")
 n1.locator(".note-drag").dblclick(position={"x":150,"y":14}); page.wait_for_timeout(300)
 inp=n1.get_by_role("textbox",name="Note title")
 check("editor opens on header dblclick",inp.count()==1)
 check("editor focused",page.evaluate("()=>document.activeElement?.getAttribute('aria-label')")=="Note title")
 inp.fill("  My plan  "); page.keyboard.press("Enter"); page.wait_for_timeout(500)
 check("PATCH sent with trimmed title",fx.patches[-1:]==[("n1",{"title":"My plan"})],fx.patches)
 check("title shown",n1.get_by_text("My plan").count()>=1)
 check("focus returns to title button",page.evaluate("()=>document.activeElement?.hasAttribute('data-note-title')"))
 check("node did not move",n1.evaluate("e=>e.style.transform")==tr0)
 page.screenshot(path=str(OUT/f"titled-{theme}.png"))
 # escape cancels
 n1.get_by_text("My plan").first.dblclick(); page.wait_for_timeout(200)
 page.keyboard.type("zzz"); page.keyboard.press("Escape"); page.wait_for_timeout(300)
 check("escape cancels",n1.get_by_text("My plan").count()>=1 and len(fx.patches)==1,fx.patches)
 # double-click body chrome (not textarea): card border area
 n1.dblclick(position={"x":238,"y":80}); page.wait_for_timeout(200)
 check("dblclick on chrome opens editor",n1.get_by_role("textbox",name="Note title").count()==1)
 # empty clears (blur)
 page.keyboard.press("Control+a"); page.keyboard.press("Delete"); n1.locator("textarea").click(); page.wait_for_timeout(500)
 check("empty clears via PATCH null",fx.patches[-1:]==[("n1",{"title":None})],fx.patches)
 # F2 path
 n1.locator(".note-drag").click(position={"x":150,"y":14}); page.keyboard.press("Escape")
 n1.click(position={"x":120,"y":10}); page.keyboard.press("F2"); page.wait_for_timeout(200)
 check("F2 opens editor",n1.get_by_role("textbox",name="Note title").count()==1)
 page.keyboard.type("F two"); page.keyboard.press("Enter"); page.wait_for_timeout(400)
 check("F2 title saved",fx.patches[-1:]==[("n1",{"title":"F two"})],fx.patches)
 # agent note rename + conflict
 n2.locator(".note-drag").dblclick(position={"x":150,"y":14}); page.wait_for_timeout(200)
 inp=n2.get_by_role("textbox",name="Note title"); check("agent note editor prefilled",inp.input_value()=="agent-plan")
 inp.fill("taken"); page.keyboard.press("Enter"); page.wait_for_timeout(600)
 t=page.evaluate(r"()=>[...document.querySelectorAll('[data-sonner-toast]')].map(t=>t.innerText)")
 check("conflict toast",any("Could not save" in x for x in t),t)
 check("title reverted after conflict",n2.get_by_text("agent-plan").count()>=1)
 n2.locator(".note-drag").dblclick(position={"x":150,"y":14}); page.wait_for_timeout(200)
 page.keyboard.press("Control+a"); page.keyboard.press("Delete"); page.keyboard.press("Enter"); page.wait_for_timeout(400)
 check("clearing agent note title blocked",fx.patches[-1][1].get("title")!=None and fx.patches[-1]==("n2",{"title":"taken"}),fx.patches[-1])
 # typing in editor doesn't drag; colour picker still present
 check("colour picker still in header",n1.get_by_role("button",name="Note color").count()==1)
 page.screenshot(path=str(OUT/f"final-{theme}.png"))
 b.close()
with sync_playwright() as p:
 for th in ("dark","light"): print("==",th); run(p,th)
print(json.dumps(res)); sys.exit(0 if all(res.values()) else 1)
