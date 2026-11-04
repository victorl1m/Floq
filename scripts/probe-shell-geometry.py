"""Capture current production shell geometry at two viewport heights using synthetic API fixtures."""
import importlib.util, json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location("verify_ui",ROOT/"scripts"/"verify-ui.py")
FIX=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(FIX)
CSPEC=importlib.util.spec_from_file_location("verify_canvas",ROOT/"scripts"/"verify-final-canvas.py")
CANVAS=importlib.util.module_from_spec(CSPEC); CSPEC.loader.exec_module(CANVAS)
OUT=ROOT/"docs"/"redesign"; OUT.mkdir(parents=True,exist_ok=True)

def main():
 import sys
 LABEL=sys.argv[1] if len(sys.argv)>1 else 'baseline'
 MAT=sys.argv[2] if len(sys.argv)>2 else 'glass'
 THEME=sys.argv[3] if len(sys.argv)>3 else 'dark'
 report={"url":"http://127.0.0.1:1421/","syntheticRuntimeOnly":True,"samples":[]}
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True); context=browser.new_context(viewport={"width":1440,"height":960})
  context.add_init_script("localStorage.setItem('theme','"+THEME+"');localStorage.setItem('floq.material','"+MAT+"');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:"+json.dumps(FIX.USER)+"}));")
  page=context.new_page(); errors=[]; page.on("pageerror",lambda e:errors.append(str(e))); fixture=CANVAS.CanvasFixture(); page.route("**/*",fixture.handle)
  page.goto(report["url"],wait_until="domcontentloaded",timeout=15000); page.get_by_role("heading",name="Start a new task").wait_for(timeout=10000)
  page.get_by_role("button",name="AGI Paulo - SARAH",exact=True).click(); node=page.locator('.react-flow__node[data-id="agi-agent-2"]'); node.wait_for(state="visible",timeout=8000); b=node.bounding_box(); page.mouse.click(b["x"]+b["width"]*.45,b["y"]+b["height"]*.5); page.wait_for_timeout(200)
  page.get_by_role("button",name="Show project panel").click(); page.locator('aside[aria-label="Project panel"]').wait_for(state="visible",timeout=5000)
  report["assets"]=page.evaluate("performance.getEntriesByType('resource').map(e=>e.name.split('/').pop()).filter(n=>/^index-.*\\.(js|css)$/.test(n))")
  for width,height,collapse in ((1440,960,False),(1440,600,False),(1440,960,True),(900,700,False)):
   if collapse: page.get_by_role('button',name='Hide navigation').click()
   await_size={'width':width,'height':height}; page.set_viewport_size(await_size); page.wait_for_timeout(400)
   sample=page.evaluate("""()=>{const rect=e=>{const r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,radius:getComputedStyle(e).borderTopLeftRadius+'/'+getComputedStyle(e).borderBottomRightRadius}:null};return {viewport:{width:innerWidth,height:innerHeight},main:rect(document.querySelector('.workspace-frame')),left:rect(document.querySelector('[data-slot="sidebar-inner"]')),right:rect(document.querySelector('.floq-right-sidebar')),scrollH:document.documentElement.scrollHeight,titlebar:rect(document.querySelector('[data-slot="titlebar"]')||document.querySelector('header')),footer:rect(document.querySelector('[data-slot="status-bar"]')||document.querySelector('footer')),asideVisible:document.querySelector('aside[aria-label="Project panel"]')?.checkVisibility()??false}}""")
   sample['collapsed']=collapse; sample["errors"]=errors.copy(); sample["bodyText"]=page.locator("body").inner_text()[:300]; report["samples"].append(sample); page.screenshot(path=str(OUT/f"shell-geometry-{LABEL}-{MAT}-{THEME}-{width}x{height}{'c' if collapse else ''}.png"),full_page=True,animations="disabled")
  context.close(); browser.close()
 report["assertions"]={"allSamplesHaveMain":all(s["main"] is not None for s in report["samples"]),"allSamplesHaveSidebar":all(s["left"] is not None for s in report["samples"]),"allSamplesHavePanel":all(s["right"] is not None for s in report["samples"])}
 (OUT/f"shell-geometry-{LABEL}-{MAT}-{THEME}.json").write_text(json.dumps(report,indent=2),encoding="utf-8"); print(json.dumps(report,indent=2))
if __name__=="__main__":main()
