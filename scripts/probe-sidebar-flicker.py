"""Frame-burst probe: click each left-sidebar item, sample screenshots of vertical bands around sidebar/frame edges, report transient column artifacts."""
import importlib.util, json, sys, io, time
from pathlib import Path
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
def load(n,f):
 s=importlib.util.spec_from_file_location(n,ROOT/"scripts"/f); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
FIX=load("verify_ui","verify-ui.py"); CANVAS=load("vfc","verify-final-canvas.py")
OUT=ROOT/"docs"/"redesign"/"sidebar-flicker"; OUT.mkdir(parents=True,exist_ok=True)
LABEL=sys.argv[1] if len(sys.argv)>1 else "before"
CONFIGS=[("dark","glass",1440,960,1),("light","glass",1440,960,1),("light","solid",1280,800,1.25),("dark","solid",1280,800,1.5),("light","glass",1024,700,1.25)]
def run(p,theme,mat,w,h,dsf,rep):
 b=p.chromium.launch(headless=True); ctx=b.new_context(viewport={"width":w,"height":h},device_scale_factor=dsf)
 ctx.add_init_script("localStorage.setItem('theme','"+theme+"');localStorage.setItem('floq.material','"+mat+"');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:"+json.dumps(FIX.USER)+"}));")
 page=ctx.new_page(); fx=CANVAS.CanvasFixture(); page.route("**/*",fx.handle)
 page.goto("http://127.0.0.1:1420/",wait_until="domcontentloaded",timeout=15000); page.wait_for_selector('[data-slot="sidebar-inner"]',timeout=15000); page.wait_for_timeout(800)

 SEL='[data-slot="sidebar-inner"] [data-slot="sidebar-menu-button"], [data-slot="sidebar-inner"] [data-slot="sidebar-menu-sub-button"], [data-slot="sidebar-inner"] [role="button"], [data-slot="sidebar-inner"] a'
 def labels():
  return page.evaluate("(sel)=>[...document.querySelectorAll(sel)].map(e=>(e.getAttribute('aria-label')||e.innerText||'').trim().split(String.fromCharCode(10))[0])",SEL)
 def boot():
  page.goto("http://127.0.0.1:1420/",wait_until="domcontentloaded",timeout=15000); page.wait_for_selector('[data-slot="sidebar-inner"]',timeout=20000); page.wait_for_timeout(900)
 boot(); names=labels()
 skip=("actions for","toggle","new folder","refresh","add to projects","hide navigation","show navigation")
 idxs=[i for i,n in enumerate(names) if n and not n.lower().startswith(skip)]
 rep.setdefault("items",[names[i] for i in idxs])
 res=[]
 cdp=ctx.new_cdp_session(page)
 for i in idxs:
  name=names[i]
  try:
   boot(); loc=page.locator(SEL).nth(i)
   geo=page.evaluate("()=>{const r=s=>document.querySelector(s)?.getBoundingClientRect();const a=r('[data-slot=\"sidebar-inner\"]'),f=r('.workspace-frame');return a&&f?{sr:a.right,fl:f.left,fr:f.right}:null}")
   if not geo: continue
   bands={"gutter":(max(0,int(geo["sr"])-6),int(geo["fl"])+8),"rightEdge":(max(0,w-14),w)}
   loc.scroll_into_view_if_needed(timeout=1500); box=loc.bounding_box()
   page.mouse.move(box["x"]+box["width"]/2,box["y"]+box["height"]/2); page.wait_for_timeout(400)
   pre=Image.open(io.BytesIO(page.screenshot())).convert("RGB")
   frames=[]; t0=[None]
   import base64
   def on_frame(ev):
    now=time.time()
    frames.append((now,Image.open(io.BytesIO(base64.b64decode(ev["data"]))).convert("RGB")))
    try: cdp.send("Page.screencastFrameAck",{"sessionId":ev["sessionId"]})
    except Exception: pass
   cdp.on("Page.screencastFrame",on_frame)
   cdp.send("Page.startScreencast",{"format":"png","everyNthFrame":1})
   page.wait_for_timeout(150); tc=time.time(); loc.click(timeout=2000); page.wait_for_timeout(900)
   cdp.send("Page.stopScreencast"); cdp.remove_listener("Page.screencastFrame",on_frame)
   page.wait_for_timeout(500); final=Image.open(io.BytesIO(page.screenshot())).convert("RGB")
   frames=[(t-tc,f.resize(final.size)) for t,f in frames if t>=tc-0.05]
   fin=np.asarray(final).astype(int); prea=np.asarray(pre).astype(int)
   worst={}
   for bn,(a,c) in bands.items():
    a=int(a*dsf); c=int(c*dsf); worst[bn]={"maxTransientCols":0,"frame":None}
    r0=int(60*dsf); r1=int((h-40)*dsf)
    for k,(t,fr) in enumerate(frames):
     arr=np.asarray(fr).astype(int)[r0:r1,a:c]
     tr=(np.abs(arr-fin[r0:r1,a:c]).max(2)>10)&(np.abs(arr-prea[r0:r1,a:c]).max(2)>10)
     cols=int((tr.mean(0)>0.5).sum())
     if cols>worst[bn]["maxTransientCols"]: worst[bn]={"maxTransientCols":cols,"frame":k,"t":round(t,3)}
    if worst[bn]["frame"] is not None:
     frames[worst[bn]["frame"]][1].crop((a-10,r0,c+10,min(r1,r0+300))).save(OUT/f"{LABEL}-{theme}-{mat}-{w}-{i}-{bn}.png")
   res.append({"item":name,"frames":len(frames),"worst":worst})
  except Exception as e: res.append({"item":name,"error":str(e)[:160]})
 b.close(); return res
def main():
 rep={"label":LABEL,"runs":[]}
 with sync_playwright() as p:
  for theme,mat,w,h,dsf in CONFIGS:
   r=run(p,theme,mat,w,h,dsf,rep); rep["runs"].append({"theme":theme,"material":mat,"viewport":[w,h],"dsf":dsf,"results":r})
   bad=[x for x in r if "worst" in x and any(v["maxTransientCols"]>0 for v in x["worst"].values())]
   print(theme,mat,w,dsf,"items",len(r),"with transient lines:",len(bad),[ (x["item"],{k:v["maxTransientCols"] for k,v in x["worst"].items()}) for x in bad][:8])
 (OUT/f"{LABEL}.json").write_text(json.dumps(rep,indent=1))
main()
