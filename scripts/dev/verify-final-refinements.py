"""Focused regression probes for frosted menus, search/home surfaces, and right-panel closing."""
from __future__ import annotations
import os
import importlib.util, json, re
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
SPEC=importlib.util.spec_from_file_location("verify_ui",ROOT / "scripts" / "dev"/"verify-ui.py")
FIX=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(FIX)
OUT=ROOT/"docs"/"redesign"; OUT.mkdir(parents=True,exist_ok=True)

def main():
 report={"url":os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421/"),"syntheticRuntimeOnly":True}
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True); context=browser.new_context(viewport={"width":1440,"height":960})
  context.add_init_script("localStorage.setItem('theme','dark');localStorage.setItem('floq.material','mica');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:"+json.dumps(FIX.USER)+"}));")
  page=context.new_page(); errors=[]; page.on("pageerror",lambda e:errors.append(str(e))); fixture=FIX.Fixture(); page.route("**/*",fixture.handle)
  page.goto(report["url"],wait_until="domcontentloaded",timeout=15000); page.get_by_role("heading",name="Start a new task").wait_for(timeout=10000); page.evaluate("document.fonts.ready")
  report["assets"]=page.evaluate("performance.getEntriesByType('resource').map(e=>e.name.split('/').pop()).filter(n=>/^index-.*\\.(js|css)$/.test(n))")
  # Search surface: measure both the FloqSurface owner and actual child control.
  search_shell=page.locator(".sidebar-search-glass"); search_shell.wait_for(state="visible",timeout=4000)
  search_geometry=page.evaluate("""()=>{const e=document.querySelector('.sidebar-search-glass'),b=e?.querySelector('button'),a=e&&getComputedStyle(e),s=b&&getComputedStyle(b),r=x=>{const z=x?.getBoundingClientRect();return z&&{x:z.x,y:z.y,width:z.width,height:z.height}};return {shell:{radius:a?.borderRadius,border:a?.border,background:a?.backgroundColor,image:a?.backgroundImage,filter:a?.backdropFilter,clip:a?.overflow,rect:r(e)},child:{radius:s?.borderRadius,border:s?.border,background:s?.backgroundColor,rect:r(b)},childWithinShell:!!e&&!!b&&(()=>{const x=e.getBoundingClientRect(),y=b.getBoundingClientRect();return y.left>=x.left&&y.top>=x.top&&y.right<=x.right+1&&y.bottom<=x.bottom+1})()}}""")
  page.screenshot(path=str(OUT/"sidebar-search-radius-dark-final.png"),full_page=True,animations="disabled")
  # Home composer field stays clear and the visible focus cue belongs to the outer surface.
  task=page.get_by_role("textbox",name="Task"); task.click(); composer=page.locator(".glass-key-surface")
  home_surface=page.evaluate("""()=>{const t=document.querySelector('#home-prompt'),c=document.querySelector('.glass-key-surface'),ts=t&&getComputedStyle(t),cs=c&&getComputedStyle(c),tf=t&&getComputedStyle(t,':focus-visible');return {textareaBackground:ts?.backgroundColor,textareaBorder:ts?.border,textareaOutline:ts?.outline,textareaFocusRing:tf?.boxShadow,textareaFocusRingStyle:tf?.outlineStyle,active:t===document.activeElement,composerBackground:cs?.backgroundColor,composerBorder:cs?.border,composerFocusShadow:cs?.boxShadow,composerFocusRing:cs?.getPropertyValue('--tw-ring-color')}}""")
  page.screenshot(path=str(OUT/"home-focused-task-dark-final.png"),full_page=True,animations="disabled")
  # Account organization submenu must portal above the canvas and remain within the viewport.
  page.get_by_role("button",name="Avery Example").click(); page.get_by_role("menuitem",name="Studio North",exact=True).hover()
  submenu=page.locator('[data-slot="dropdown-menu-sub-content"]'); submenu.wait_for(state="visible",timeout=4000); page.wait_for_timeout(120)
  page.screenshot(path=str(OUT/"account-organization-submenu-dark-final.png"),full_page=True,animations="disabled")
  submenu_geometry=page.evaluate("""()=>{const e=document.querySelector('[data-slot=\"dropdown-menu-sub-content\"]'),s=e&&getComputedStyle(e),r=e?.getBoundingClientRect(),p=document.elementFromPoint(Math.min(innerWidth-2,(r?.left??0)+r.width/2),Math.min(innerHeight-2,(r?.top??0)+20));return {visible:!!e&&s.visibility==='visible',role:e?.getAttribute('role'),state:e?.getAttribute('data-state'),zIndex:s?.zIndex,background:s?.backgroundColor,backdropFilter:s?.backdropFilter,radius:s?.borderRadius,rect:r&&{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},inViewport:!!r&&r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,hitTarget:{tag:p?.tagName,slot:p?.getAttribute('data-slot'),text:p?.textContent?.trim().slice(0,60)},textColor:e&&getComputedStyle(e.querySelector('[role=menuitemradio]')).color}}""")
  page.keyboard.press("Escape"); page.wait_for_timeout(120); page.keyboard.press("Escape"); page.wait_for_timeout(250)
  menu_dismiss=page.evaluate("""()=>({openRoot:[...document.querySelectorAll('[data-slot=\"dropdown-menu-content\"][data-state=\"open\"]')].length,openSub:[...document.querySelectorAll('[data-slot=\"dropdown-menu-sub-content\"][data-state=\"open\"]')].length,scrollLocked:document.body.hasAttribute('data-scroll-locked'),activeTag:document.activeElement?.tagName,activeLabel:document.activeElement?.getAttribute('aria-label')})""")
  report["partial"]={"searchGeometry":search_geometry,"homeSurface":home_surface,"organizationSubmenu":submenu_geometry,"menuDismissAfterEscapes":menu_dismiss}
  (OUT/"final-refinements-partial.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
  # Canvas open, then measure close animation and a rapid reopen while its exit timer is active.
  page.get_by_role("button",name="AGI Paulo - SARAH",exact=True).click(); canvas_node=page.locator(".react-flow__node[data-id=\"agi-agent-1\"]"); canvas_node.wait_for(state="visible",timeout=8000); nb=canvas_node.bounding_box(); page.mouse.click(nb["x"]+nb["width"]*.45,nb["y"]+nb["height"]*.5); page.wait_for_timeout(250)
  page.get_by_role("button",name="Show project panel").click(); page.wait_for_timeout(0)
  panel=page.locator("aside[aria-label=\"Project panel\"]"); panel_states=[]
  panel_start=page.evaluate("performance.now()")
  for delay in (0,100,300,700):
   elapsed=page.evaluate("t=>performance.now()-t",panel_start)
   if delay>elapsed: page.wait_for_timeout(delay-elapsed)
   panel_states.append(page.evaluate("""()=>{const e=document.querySelector('aside[aria-label=\"Project panel\"]'),r=e?.getBoundingClientRect(),t=document.querySelector('button[title=\"Project panel\"]');return {elapsedMs:performance.now(),mounted:!!e,ariaHidden:e?.getAttribute('aria-hidden'),inert:e?.hasAttribute('inert'),state:e?.getAttribute('data-state'),opacity:e&&getComputedStyle(e).opacity,transform:e&&getComputedStyle(e).transform,width:r?.width,right:r?.right,triggerLabel:t?.getAttribute('aria-label'),pressed:t?.getAttribute('aria-pressed'),canvas:!!document.querySelector('.react-flow'),openRootMenus:document.querySelectorAll('[data-slot=\"dropdown-menu-content\"][data-state=\"open\"]').length,openSubmenus:document.querySelectorAll('[data-slot=\"dropdown-menu-sub-content\"][data-state=\"open\"]').length,scrollLocked:document.body.hasAttribute('data-scroll-locked')}}"""))
  mid=panel_states[min(1,len(panel_states)-1)] if panel_states else {}; rapid_reopen=False; rapid_geometry={}; reduced_close={"panel":panel.count()>0,"reduced":False,"activeLabel":page.evaluate("document.activeElement?.getAttribute('aria-label')")}
  if panel.count():
   page.screenshot(path=str(OUT/"right-panel-open-dark-final.png"),full_page=True,animations="disabled")
   page.get_by_role("button",name="Close project panel").click(); page.wait_for_timeout(70)
   mid=page.evaluate("""()=>{const e=document.querySelector('[aria-label=\"Project panel\"]'),r=e?.getBoundingClientRect();return {mounted:!!e,ariaHidden:e?.getAttribute('aria-hidden'),inert:e?.hasAttribute('inert'),visibility:e&&getComputedStyle(e).visibility,opacity:e&&getComputedStyle(e).opacity,transform:e&&getComputedStyle(e).transform,width:r?.width,right:r?.right,activeLabel:document.activeElement?.getAttribute('aria-label'),activeInsidePanel:!!document.activeElement?.closest('[aria-label=\"Project panel\"]'),trigger:document.querySelector('button[title=\"Project panel\"]')?.getAttribute('aria-pressed')}}""")
   page.locator("button[title=\"Project panel\"]").click(); page.wait_for_timeout(300); rapid_reopen=panel.count()>0 and panel.is_visible()
   rapid_geometry=panel.evaluate("e=>({opacity:getComputedStyle(e).opacity,width:e.getBoundingClientRect().width})")
   page.emulate_media(reduced_motion="reduce"); page.get_by_role("button",name="Close project panel").click(); page.wait_for_timeout(60)
   reduced_close=page.evaluate("""()=>({panel:!!document.querySelector('[aria-label=\"Project panel\"]'),activeLabel:document.activeElement?.getAttribute('aria-label'),triggerPressed:document.querySelector('button[title=\"Project panel\"]')?.getAttribute('aria-pressed'),reduced:matchMedia('(prefers-reduced-motion: reduce)').matches})""")
  report.update({"searchGeometry":search_geometry,"homeSurface":home_surface,"organizationSubmenu":submenu_geometry,"menuDismissAfterEscapes":menu_dismiss,"rightPanelLifecycle":panel_states,"rightPanelCloseAt70ms":mid,"rapidReopen":rapid_reopen,"rapidReopenGeometry":rapid_geometry,"reducedMotionClose":reduced_close,"pageErrors":errors})
  context.close(); browser.close()
 report["assertions"]={
  "searchShellAndChildHaveRoundedCorners":bool(search_geometry["shell"]["radius"] and any(float(v.replace('px',''))>0 for v in search_geometry["shell"]["radius"].split())) and bool(search_geometry["child"]["radius"] and any(float(v.replace('px',''))>0 for v in search_geometry["child"]["radius"].split())) and search_geometry["childWithinShell"],
  "taskTextareaClearAndNoInnerFocusRing":report["homeSurface"]["textareaBackground"] in ("rgba(0, 0, 0, 0)","transparent") and report["homeSurface"]["textareaBorder"].startswith("0px") and report["homeSurface"]["textareaOutline"].split()[1]=="none" and report["homeSurface"]["textareaFocusRing"] in ("none","",None),
  "orgSubmenuVisibleAboveOverlayAndViewport":report["organizationSubmenu"]["visible"] and report["organizationSubmenu"]["inViewport"] and int(report["organizationSubmenu"]["zIndex"])>=50,
  "rightPanelCanRapidReopen":report["rapidReopen"],
  "reducedMotionCloseCompletesAndTriggerRestored":report["reducedMotionClose"].get("reduced",False) and not report["reducedMotionClose"].get("panel",True) and report["reducedMotionClose"].get("activeLabel")=="Show project panel",
  "noPageErrors":not report["pageErrors"]}
 report["summary"]={"passed":sum(report["assertions"].values()),"total":len(report["assertions"]),"allPassed":all(report["assertions"].values())}
 (OUT/"final-refinements-verification.json").write_text(json.dumps(report,indent=2),encoding="utf-8"); print(json.dumps(report,indent=2))
 if not report["summary"]["allPassed"]: raise SystemExit(1)
if __name__=="__main__":main()



