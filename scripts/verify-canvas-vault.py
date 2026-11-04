"""Global vault popover on the canvas: 2 secrets, empty state, light + dark, live refresh."""
from __future__ import annotations
import importlib.util, json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,ROOT/"scripts"/file); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
FIX=load("verify_ui","verify-ui.py"); CANVAS=load("vfc","verify-final-canvas.py")
OUT=ROOT/"docs"/"redesign"
S=lambda n:{"name":n,"description":"Synthetic","expose":"tool","createdAt":"2026-01-01T12:00:00Z","updatedAt":"2026-01-01T12:00:00Z","lastUsedAt":None}
class F(CANVAS.CanvasFixture):
 secrets=[S("DOCS_TOKEN"),S("STRIPE_API_KEY")]; fail=False
 def handle(self,route):
  if urlparse(route.request.url).path=="/v1/vault" and route.request.method=="GET":
   if self.fail: route.fulfill(status=500,content_type="application/json",body=json.dumps({"error":"boom"})); return
   route.fulfill(status=200,content_type="application/json",body=json.dumps({"secrets":self.secrets})); return
  super().handle(route)

def run(theme,fx,shot,p):
 b=p.chromium.launch(headless=True); c=b.new_context(viewport={"width":1440,"height":960})
 c.add_init_script(f"localStorage.setItem('theme','{theme}');localStorage.setItem('floq.material','glass');localStorage.setItem('floq.connection',JSON.stringify({{baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:{json.dumps(FIX.USER)}}}));")
 pg=c.new_page(); errs=[]; pg.on("pageerror",lambda e:errs.append(str(e))); pg.route("**/*",fx.handle)
 pg.goto("http://127.0.0.1:1421/",wait_until="domcontentloaded"); pg.get_by_role("heading",name="Start a new task").wait_for(timeout=10000)
 pg.get_by_role("button",name="AGI Paulo - SARAH",exact=True).click(); pg.locator('.react-flow__node[data-id="agi-agent-2"]').wait_for(timeout=10000)
 btn=pg.get_by_role("button",name=__import__("re").compile("Global vault")); btn.wait_for(timeout=5000); res={"label":btn.get_attribute("aria-label")}
 btn.click(); pg.wait_for_timeout(300)
 pop=pg.locator('[data-slot="popover-content"]'); res["text"]=pop.inner_text(); res["html_has_values"]="sk_" in pop.inner_html()
 pg.screenshot(path=str(OUT/shot),animations="disabled"); res["errors"]=errs; b.close(); return res
with sync_playwright() as p:
 out={}
 for t in("dark","light"): out[t+"-2secrets"]=run(t,F(),f"canvas-vault-{t}.png",p)
 e=F(); e.secrets=[]; out["light-empty"]=run("light",e,"canvas-vault-empty-light.png",p)
 e=F(); e.secrets=[]; out["dark-empty"]=run("dark",e,"canvas-vault-empty-dark.png",p)
 f=F(); f.fail=True; out["dark-error"]=run("dark",f,"canvas-vault-error-dark.png",p)
 print(json.dumps(out,indent=1))
