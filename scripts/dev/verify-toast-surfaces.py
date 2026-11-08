"""Exercise real Sonner toasts from synthetic port events and verify viewport/layout behavior."""
import os
import importlib.util, json, re
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[2]
SPEC=importlib.util.spec_from_file_location("verify_canvas",ROOT / "scripts" / "dev"/"verify-final-canvas.py")
CANVAS=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(CANVAS)
OUT=ROOT/"docs"/"redesign"; OUT.mkdir(parents=True,exist_ok=True)
URL=os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421/")

class ToastFixture(CANVAS.CanvasFixture):
 def handle(self,route):
  if route.request.method=="POST" and route.request.url.split("?")[0].endswith("/v1/sessions"):
   route.fulfill(status=503,content_type="application/json",body=json.dumps({"error":{"code":"synthetic_denied","message":"Synthetic agent creation failed"}})); return
  super().handle(route)

def run_case(browser,theme,label):
 context=browser.new_context(viewport={"width":1440,"height":960})
 context.add_init_script("localStorage.setItem('theme',"+json.dumps(theme)+");localStorage.setItem('floq.material','mica');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:"+json.dumps(CANVAS.FIX.USER)+"}));")
 page=context.new_page(); errors=[]; page.on("pageerror",lambda e:errors.append(str(e))); fixture=ToastFixture(); page.route("**/*",fixture.handle)
 page.goto(URL,wait_until="domcontentloaded",timeout=15000); page.get_by_role("heading",name="Start a new task").wait_for(timeout=10000)
 page.get_by_role("button",name="Select project").click(); page.get_by_role("menuitem",name=re.compile("AGI Paulo - SARAH")).first.click()
 for i in range(3):
  page.get_by_role("textbox",name="Task").fill(f"Synthetic toast failure {i+1}")
  page.get_by_role("button",name="Start agent").click()
  page.wait_for_function("n=>document.querySelectorAll('[data-sonner-toast] .cn-toast-title').length>=n",arg=i+1,timeout=5000)
  if i<2: page.wait_for_timeout(100)
 page.wait_for_function("document.querySelectorAll('[data-sonner-toast]').length>=3",timeout=5000)
 page.wait_for_timeout(120)
 def snapshot():
  return page.evaluate("""()=>{const toaster=document.querySelector('[data-sonner-toaster]'),tr=toaster?.getBoundingClientRect();const toasts=[...document.querySelectorAll('[data-sonner-toast]')];return {theme:document.documentElement.classList.contains('dark')?'dark':'light',material:document.documentElement.dataset.material,viewport:{width:innerWidth,height:innerHeight},toaster:toaster&&{x:tr.x,y:tr.y,right:tr.right,bottom:tr.bottom,width:tr.width,height:tr.height,xPosition:toaster.getAttribute('data-x-position'),yPosition:toaster.getAttribute('data-y-position'),style:toaster.getAttribute('style')},items:toasts.map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect(),title=e.querySelector('[data-title]'),desc=e.querySelector('[data-description]');return {text:e.innerText,role:e.getAttribute('role'),type:e.getAttribute('data-type'),rect:{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height},background:s.backgroundColor,backgroundImage:s.backgroundImage,border:s.border,borderRadius:s.borderRadius,boxShadow:s.boxShadow,backdropFilter:s.backdropFilter,titleColor:title&&getComputedStyle(title).color,descriptionColor:desc&&getComputedStyle(desc).color,buttons:[...e.querySelectorAll('button')].map(b=>({name:b.getAttribute('aria-label')||b.innerText,rect:(()=>{const x=b.getBoundingClientRect();return{x:x.x,y:x.y,right:x.right,bottom:x.bottom}})()}))}}),activeFilters:[...document.querySelectorAll('[data-sonner-toast]')].map(e=>getComputedStyle(e).backdropFilter),invokeCalls:window.__tauriInvokes||[]}}""")
 dark_or_theme=snapshot(); page.screenshot(path=str(OUT/f"toast-stack-{label}-desktop.png"),full_page=True,animations="disabled")
 before_dismiss=snapshot()
 dismiss=page.get_by_role("button",name="Dismiss notification").first; dismiss.click(); page.wait_for_timeout(550); after_dismiss=snapshot()
 page.set_viewport_size({"width":390,"height":844}); page.wait_for_timeout(550); narrow=snapshot(); page.screenshot(path=str(OUT/f"toast-stack-{label}-narrow.png"),full_page=True,animations="disabled")
 result={"assets":page.evaluate("performance.getEntriesByType('resource').map(e=>e.name.split('/').pop()).filter(n=>/^index-.*\\.(js|css)$/.test(n))"),"initial":dark_or_theme,"beforeDismiss":before_dismiss,"afterDismiss":after_dismiss,"narrow":narrow,"pageErrors":errors,"eventSource":"Three real failed create-session submissions against synthetic 503 fixture responses."}
 result["assertions"]={
  "topCenteredBelowTitlebar":bool(dark_or_theme["toaster"] and dark_or_theme["toaster"]["xPosition"]=="center" and dark_or_theme["toaster"]["yPosition"]=="top" and all(x["rect"]["y"]>=40 for x in dark_or_theme["items"])),
  "threeSyntheticStatusToastsStack":len(dark_or_theme["items"])==3,
  "toastsStayInsideDesktopViewport":all(x["rect"]["x"]>=0 and x["rect"]["right"]<=1441 for x in dark_or_theme["items"]),
  "glassBlurOnToasts":all("blur(" in x for x in dark_or_theme["activeFilters"]),
  "dismissButtonRemovesToast":len(after_dismiss["items"])<len(before_dismiss["items"]),
  "narrowToastsBounded":all(x["rect"]["x"]>=0 and x["rect"]["right"]<=391 for x in narrow["items"]),
  "noPageErrors":not errors,
 }
 context.close(); return result

def main():
 report={"url":URL,"syntheticRuntimeOnly":True,"cases":{}}
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True)
  report["cases"]["dark"]=run_case(browser,"dark","dark")
  report["cases"]["light"]=run_case(browser,"light","light")
  browser.close()
 report["assertions"]={f"{theme}.{name}":value for theme,case in report["cases"].items() for name,value in case["assertions"].items()}
 report["summary"]={"passed":sum(report["assertions"].values()),"total":len(report["assertions"]),"allPassed":all(report["assertions"].values())}
 (OUT/"toast-surfaces-final-verification.json").write_text(json.dumps(report,indent=2),encoding="utf-8"); print(json.dumps(report,indent=2))
 if not report["summary"]["allPassed"]: raise SystemExit(1)
if __name__=="__main__":main()
