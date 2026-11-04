"""Link/hover glow states on agent cards. usage: python probe-link-glow.py <tag> [light|dark] [glass|solid]"""
from __future__ import annotations
import os
import importlib.util, json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("vfc",ROOT/"scripts"/"verify-final-canvas.py"); V=importlib.util.module_from_spec(spec); spec.loader.exec_module(V)
FIX=V.FIX
tag=sys.argv[1] if len(sys.argv)>1 else "after"; theme=sys.argv[2] if len(sys.argv)>2 else "dark"; material=sys.argv[3] if len(sys.argv)>3 else "glass"
OUT=ROOT/"docs"/"redesign"/"link-glow"; OUT.mkdir(parents=True,exist_ok=True)
CARD="canvas-agent-card-material"
def info(page,i):
 return page.evaluate("""(i)=>{const n=document.querySelector('.react-flow__node[data-id="'+i+'"]');const c=n.querySelector('.canvas-agent-card-material');const s=getComputedStyle(c);const h=n.querySelector('.canvas-node-halo');const o=(pe)=>h?getComputedStyle(h,pe).opacity:null;return {state:n.querySelector('.canvas-node-wrap')?.dataset.linkState||null,halo:h?[o(null),o('::before'),o('::after')].join('/'):null,border:s.borderColor,opacity:s.opacity,z:getComputedStyle(n).zIndex,overflow:s.overflow}}""",i)
def main():
 res={}
 with sync_playwright() as p:
  b=p.chromium.launch(headless=True); ctx=b.new_context(viewport={"width":1440,"height":960})
  ctx.add_init_script(f"localStorage.setItem('theme','{theme}');localStorage.setItem('floq.material','{material}');localStorage.setItem('floq.connection',JSON.stringify({{baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:"+json.dumps(FIX.USER)+"}));")
  page=ctx.new_page(); page.on("pageerror",lambda e:print("PAGEERR",str(e)[:300])); page.route("**/*",V.CanvasFixture().handle)
  page.goto(os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1420/"),wait_until="domcontentloaded"); page.get_by_role("heading",name="Start a new task").wait_for(timeout=10000)
  page.get_by_role("button",name="AGI Paulo - SARAH",exact=True).click()
  for i in ("agi-agent-1","agi-agent-2","agi-agent-3"): page.locator(f'.react-flow__node[data-id="{i}"]').wait_for(state="visible",timeout=10000)
  if tag=='before': page.add_style_tag(content='.canvas-node-halo,.canvas-side-strip::after{display:none!important}')  # old visuals: the halo did not exist
  page.wait_for_timeout(800)
  def shot(name): page.screenshot(path=str(OUT/f"{tag}-{theme}-{material}-{name}.png"),animations="disabled")
  def box(i): return page.locator(f'.react-flow__node[data-id="{i}"]').bounding_box()
  def ctr(i): x=box(i); return x["x"]+x["width"]*.5,x["y"]+x["height"]*.5
  page.mouse.move(700,900); page.wait_for_timeout(300); res["idle"]=info(page,"agi-agent-2"); shot("idle")
  page.mouse.move(*ctr("agi-agent-2")); page.wait_for_timeout(300); res["hover"]=info(page,"agi-agent-2"); shot("hover")
  page.mouse.move(700,900)
  page.mouse.click(700,900); page.keyboard.press("l"); page.wait_for_timeout(300); res["linkmode"]=info(page,"agi-agent-3"); shot("linkmode")
  page.mouse.click(*ctr("agi-agent-2")); page.wait_for_timeout(300); res["source"]=info(page,"agi-agent-2"); res["candidate"]=info(page,"agi-agent-3"); shot("linkmode-source")
  page.mouse.move(*ctr("agi-agent-3")); page.wait_for_timeout(300); res["linkhover"]=info(page,"agi-agent-3"); shot("linkmode-hover-target")
  page.keyboard.press("Escape"); page.wait_for_timeout(200)
  # drag from handle strip (right edge of agent-1)
  b1=box("agi-agent-1"); hx,hy=b1["x"]+b1["width"]+7,b1["y"]+b1["height"]/2
  page.mouse.move(hx,hy); page.wait_for_timeout(250); shot("handle-hover")
  res["handle"]=page.evaluate("(()=>{const h=document.querySelector('.react-flow__node[data-id=\"agi-agent-1\"] [data-handleid=\"right\"]');const s=getComputedStyle(h);return {transform:s.transform,shadow:s.boxShadow,bg:s.backgroundColor}})()")
  page.mouse.down(); page.mouse.move(hx+60,hy+10,steps=4); page.wait_for_timeout(200); res["drag_source"]=info(page,"agi-agent-1"); res["drag_candidate"]=info(page,"agi-agent-3"); shot("drag")
  page.mouse.move(*ctr("agi-agent-3"),steps=8); page.wait_for_timeout(300); res["drag_hover"]=info(page,"agi-agent-3"); shot("drag-hover-target")
  page.mouse.up(); page.wait_for_timeout(120); res["linked_pulse"]=info(page,"agi-agent-3"); shot("linked-moment"); page.wait_for_timeout(900)
  # wire hover/select
  e=page.locator(".react-flow__edge-interaction").first
  eb=e.bounding_box() if e.count() else None
  if eb:
   page.mouse.move(eb["x"]+eb["width"]/2,eb["y"]+eb["height"]/2); page.wait_for_timeout(250); shot("wire-hover")
   res["wirehover"]={i:info(page,i)["state"] for i in ("agi-agent-1","agi-agent-2","agi-agent-3")}
   page.mouse.click(eb["x"]+eb["width"]/2,eb["y"]+eb["height"]/2); page.wait_for_timeout(250); shot("wire-selected")
   res["wiresel"]={i:info(page,i)["state"] for i in ("agi-agent-1","agi-agent-2","agi-agent-3")}
  # keyboard focus
  page.mouse.move(700,920); page.locator('.react-flow__node[data-id="agi-agent-2"]').focus(); page.keyboard.press("Tab"); page.keyboard.press("Shift+Tab"); page.wait_for_timeout(250); shot("focus")
  res["focus"]=info(page,"agi-agent-2")
  b.close()
 print(json.dumps(res,indent=1))
 (OUT/f"{tag}-{theme}-{material}.json").write_text(json.dumps(res,indent=1))
main()
