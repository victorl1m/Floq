"""Focused synthetic fixture checks for canvas project context, wires, and sidebar collapse."""
from __future__ import annotations
import os
import importlib.util, json, re
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location("verify_ui", ROOT/"scripts"/"verify-ui.py")
FIX=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(FIX)
OUT=ROOT/"docs"/"redesign"; OUT.mkdir(parents=True,exist_ok=True)
LINKS=[
 {"id":"link-1","projectId":"project-agi","fromSessionId":"agi-agent-1","toSessionId":"agi-agent-2","kind":"recruit","createdAt":"2026-01-01T12:00:00Z","lastMessageAt":None,"messageCount":0},
 {"id":"link-2","projectId":"project-agi","fromSessionId":"agi-agent-1","toSessionId":"agi-agent-3","kind":"manual","createdAt":"2026-01-01T12:01:00Z","lastMessageAt":None,"messageCount":1},
 {"id":"link-3","projectId":"project-agi","fromSessionId":"agi-agent-2","toSessionId":"agi-agent-3","kind":"message","createdAt":"2026-01-01T12:02:00Z","lastMessageAt":None,"messageCount":2},
]
PATCH="""diff --git a/src/review.ts b/src/review.ts\nindex 0000000..1111111 100644\n--- a/src/review.ts\n+++ b/src/review.ts\n@@ -1 +1,2 @@\n export const result = 'old';\n+export const reviewed = true;\n"""

class CanvasFixture(FIX.Fixture):
 def handle(self,route):
  path=urlparse(route.request.url).path
  if path=="/v1/projects/project-agi/links":
   route.fulfill(status=200,content_type="application/json",body=json.dumps({"links":LINKS})); return
  m=re.fullmatch(r"/v1/sessions/(agi-agent-[123])/(changes|diff|files|files/content)",path)
  if m:
   sid,kind=m.groups(); worktree=sid in ("agi-agent-2","agi-agent-3")
   branch="floq/research-pass" if worktree else "main"
   name="src/review.ts" if worktree else "README.md"
   if kind=="changes": body={"repository":"/synthetic/agi-paulo" if not worktree else "/synthetic/agi-paulo/.worktrees/research","branch":branch,"changes":[{"path":name,"status":"modified","staged":False,"unstaged":True,"untracked":False}],"truncated":False}
   elif kind=="diff": body={"path":name,"patch":PATCH.replace("src/review.ts",name),"binary":False,"tooLarge":False}
   elif kind=="files": body={"path":"","entries":[{"name":"src","path":"src","type":"dir"},{"name":"README.md","path":"README.md","type":"file"},{"name":"review.ts","path":"review.ts","type":"file"}],"truncated":False}
   else: body={"path":"README.md","size":38,"binary":False,"tooLarge":False,"content":"# Synthetic workspace\n\nVerified fixture content.\n"}
   route.fulfill(status=200,content_type="application/json",body=json.dumps(body)); return
  super().handle(route)

class EmptyWorkspaceFixture(CanvasFixture):
 def handle(self,route):
  if urlparse(route.request.url).path=="/v1/projects":
   projects=json.loads(json.dumps(FIX.PROJECTS)); project=next(x for x in projects if x["id"]=="project-agi")
   project["workspaces"].insert(0,{"id":"agi-empty","cwd":"/synthetic/agi-paulo/.worktrees/empty-review","name":"Empty review checkout","branch":"floq/empty-review","isWorktree":True,"sessionIds":[]})
   route.fulfill(status=200,content_type="application/json",body=json.dumps({"projects":projects})); return
  super().handle(route)

def main():
 report={"url":os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421/"),"syntheticRuntimeOnly":True,"cases":[]}
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True)
  context=browser.new_context(viewport={"width":1440,"height":960})
  context.add_init_script("localStorage.setItem('theme','dark');localStorage.setItem('floq.material','mica');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:"+json.dumps(FIX.USER)+"}));")
  page=context.new_page(); errors=[]; page.on("pageerror",lambda e:errors.append(str(e))); fixture=CanvasFixture(); page.route("**/*",fixture.handle)
  page.goto(report["url"],wait_until="domcontentloaded",timeout=15000); page.get_by_role("heading",name="Start a new task").wait_for(timeout=10000); page.evaluate("document.fonts.ready")
  report["assets"]=page.evaluate("performance.getEntriesByType('resource').map(e=>e.name.split('/').pop()).filter(n=>/^index-.*\\.(js|css)$/.test(n))")
  # Sidebar focus recovery: close while a real navigation item owns keyboard focus.
  nav=page.locator("#app-navigation-sidebar"); home=nav.get_by_role("button",name="Home"); home.focus(); page.keyboard.press("Control+b"); page.wait_for_timeout(350)
  page.screenshot(path=str(OUT/"sidebar-closed-dark-final.png"),full_page=True,animations="disabled")
  collapsed=page.evaluate("""()=>{const root=document.querySelector('#app-navigation-sidebar'),gap=document.querySelector('[data-slot=\"sidebar-gap\"]'),container=document.querySelector('[data-slot=\"sidebar-container\"]'),inner=document.querySelector('[data-slot=\"sidebar-inner\"]'),trigger=document.querySelector('[data-slot=\"sidebar-trigger\"]'),a=document.activeElement;const r=e=>{const x=e?.getBoundingClientRect();return x?{x:x.x,width:x.width,right:x.right}:null};const hit=document.elementFromPoint(2,220);return {state:root?.getAttribute('data-state'),collapsible:root?.getAttribute('data-collapsible'),inert:root?.hasAttribute('inert'),ariaHidden:root?.getAttribute('aria-hidden'),gap:r(gap),container:r(container),inner:r(inner),edgeHit:{tag:hit?.tagName,slot:hit?.getAttribute('data-slot'),text:hit?.textContent?.trim().slice(0,30)},focused:{tag:a?.tagName,label:a?.getAttribute('aria-label'),slot:a?.getAttribute('data-slot'),focusVisible:a?.matches(':focus-visible')},triggerLabel:trigger?.getAttribute('aria-label'),railCount:document.querySelectorAll('[data-slot=\"sidebar-rail\"]').length,navHomeHidden:!document.querySelector('[aria-label=\"Workspace navigation\"] button[aria-current=\"page\"]')?.checkVisibility()}}""")
  page.keyboard.press("Tab"); collapsed["tabOutsideSidebar"]=page.evaluate("!document.activeElement.closest('#app-navigation-sidebar')")
  page.keyboard.press("Control+b"); page.wait_for_timeout(350)
  reopened=page.evaluate("""()=>({state:document.querySelector('#app-navigation-sidebar')?.getAttribute('data-state'),homeVisible:document.querySelector('[aria-label=\"Workspace navigation\"] button[aria-current=\"page\"]')?.checkVisibility(),focus:{label:document.activeElement?.getAttribute('aria-label'),slot:document.activeElement?.getAttribute('data-slot')}})""")
  # Regression sequence: Escape closes the organization submenu first, then the account root menu.
  page.get_by_role("button",name="Avery Example").click(); page.get_by_role("menuitem",name="Studio North",exact=True).hover(); page.wait_for_timeout(100)
  menu_open=page.evaluate("""()=>({root:[...document.querySelectorAll('[data-slot=\"dropdown-menu-content\"]')].map(e=>e.getAttribute('data-state')).filter(x=>x==='open').length,sub:[...document.querySelectorAll('[data-slot=\"dropdown-menu-sub-content\"]')].map(e=>e.getAttribute('data-state')).filter(x=>x==='open').length,bodyScrollLocked:document.body.hasAttribute('data-scroll-locked'),focus:document.activeElement?.getAttribute('role')})""")
  page.keyboard.press("Escape"); page.wait_for_timeout(120)
  pointer_escape=page.evaluate("""()=>({root:[...document.querySelectorAll('[data-slot=\"dropdown-menu-content\"][data-state=\"open\"]')].length,sub:[...document.querySelectorAll('[data-slot=\"dropdown-menu-sub-content\"][data-state=\"open\"]')].length,bodyScrollLocked:document.body.hasAttribute('data-scroll-locked')})""")
  if pointer_escape["root"] or pointer_escape["sub"]: page.keyboard.press("Escape"); page.wait_for_timeout(180)
  page.get_by_role("button",name="Avery Example").click(); org_item=page.get_by_role("menuitem",name="Studio North",exact=True); org_item.focus(); org_item.press("ArrowRight"); page.wait_for_timeout(120); page.keyboard.press("ArrowDown"); page.wait_for_timeout(80)
  keyboard_submenu_open=page.evaluate("""()=>({root:[...document.querySelectorAll('[data-slot=\"dropdown-menu-content\"][data-state=\"open\"]')].length,sub:[...document.querySelectorAll('[data-slot=\"dropdown-menu-sub-content\"][data-state=\"open\"]')].length,activeText:document.activeElement?.textContent?.trim(),activeHtml:document.activeElement?.outerHTML?.slice(0,500),activeInSubmenu:!!document.activeElement?.closest('[data-slot=\"dropdown-menu-sub-content\"]'),activeAncestors:[...function*(e){for(let n=e;n&&n!==document.body;n=n.parentElement)yield {tag:n.tagName,slot:n.getAttribute('data-slot'),role:n.getAttribute('role'),state:n.getAttribute('data-state'),text:n.textContent?.trim().slice(0,60)}}(document.activeElement)],bodyScrollLocked:document.body.hasAttribute('data-scroll-locked')})""")
  page.keyboard.press("ArrowLeft"); page.wait_for_timeout(120)
  after_arrow_left=page.evaluate("""()=>({root:[...document.querySelectorAll('[data-slot=\"dropdown-menu-content\"][data-state=\"open\"]')].length,sub:[...document.querySelectorAll('[data-slot=\"dropdown-menu-sub-content\"][data-state=\"open\"]')].length,activeText:document.activeElement?.textContent?.trim(),activeSlot:document.activeElement?.getAttribute('data-slot'),bodyScrollLocked:document.body.hasAttribute('data-scroll-locked')})""")
  page.keyboard.press("Escape"); page.wait_for_timeout(250)
  after_escape_root=page.evaluate("""()=>({root:[...document.querySelectorAll('[data-slot=\"dropdown-menu-content\"][data-state=\"open\"]')].length,sub:[...document.querySelectorAll('[data-slot=\"dropdown-menu-sub-content\"][data-state=\"open\"]')].length,bodyScrollLocked:document.body.hasAttribute('data-scroll-locked'),activeTag:document.activeElement?.tagName,activeLabel:document.activeElement?.getAttribute('aria-label'),bodyPointerEvents:getComputedStyle(document.body).pointerEvents})""")
  # Enter canvas by the real project row; select a node body (not its Open terminal action).
  page.get_by_role("button",name="AGI Paulo - SARAH",exact=True).click(); node=page.locator('.react-flow__node[data-id="agi-agent-2"]'); node.wait_for(state="visible",timeout=10000); page.wait_for_timeout(700)
  box=node.bounding_box(); page.mouse.click(box["x"]+box["width"]*.45,box["y"]+box["height"]*.5); page.wait_for_timeout(250)
  page.get_by_role("button",name="Show project panel").click(); page.wait_for_timeout(250)
  panel_raw=page.evaluate("""()=>{const rect=e=>{const r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}:null};const candidates=[...document.querySelectorAll('main,[data-slot=\"sidebar-inner\"],#app-navigation-sidebar,.workspace-frame,.workspace-content,.app-main,.floq-main-frame,[aria-label=\"Project panel\"]')];return {viewCanvas:!!document.querySelector('.react-flow'),nodes:[...document.querySelectorAll('.react-flow__node')].map(e=>e.getAttribute('data-id')),projectTitle:document.querySelector('.react-flow__panel [title]')?.getAttribute('title'),trigger:document.querySelector('button[title=\"Project panel\"]')?.getAttribute('aria-pressed'),asides:[...document.querySelectorAll('aside')].map(e=>({label:e.getAttribute('aria-label'),state:e.getAttribute('data-state'),inert:e.hasAttribute('inert'),ariaHidden:e.getAttribute('aria-hidden'),rect:rect(e)})),frameCandidates:candidates.map(e=>({tag:e.tagName,id:e.id,slot:e.getAttribute('data-slot'),className:typeof e.className==='string'?e.className:'',label:e.getAttribute('aria-label'),rect:rect(e)})),rawAsideCount:document.querySelectorAll('aside[aria-label=\"Project panel\"]').length,roleAsideCount:[...document.querySelectorAll('[role=complementary]')].filter(e=>e.getAttribute('aria-label')==='Project panel').length,openMenus:document.querySelectorAll('[data-slot=\"dropdown-menu-content\"][data-state=\"open\"]').length,openSubmenus:document.querySelectorAll('[data-slot=\"dropdown-menu-sub-content\"][data-state=\"open\"]').length,scrollLocked:document.body.hasAttribute('data-scroll-locked'),pointerEvents:getComputedStyle(document.body).pointerEvents}}""")
  panel=page.get_by_role("complementary",name="Project panel"); panel.wait_for(state="visible",timeout=5000); page.wait_for_timeout(350)
  header=page.get_by_role("group",name=re.compile("AGI Paulo.*Research pass")); header.wait_for(state="visible",timeout=5000)
  changes=page.locator("#right-sidebar-tab-changes"); changes.click(); page.get_by_text("floq/research-pass",exact=True).first.wait_for(timeout=6000); page.wait_for_timeout(1500); page.get_by_text("review.ts",exact=True).first.wait_for(timeout=6000)
  page.screenshot(path=str(OUT/"canvas-right-sidebar-research-dark-final.png"),full_page=True,animations="disabled")
  changes_context=page.evaluate("""()=>{const p=document.querySelector('[aria-label=\"Project panel\"]'),t=p?.querySelector('[role=tab][aria-selected=true]'),h=p?.querySelector('[role=group]'),nodes=[...document.querySelectorAll('.react-flow__node')];return {viewCanvas:!!document.querySelector('.react-flow'),panel:!!p,header:h?.getAttribute('aria-label'),tab:t?.id,branchText:p?.innerText.includes('floq/research-pass'),changeText:p?.innerText.includes('review.ts'),terminalDialogs:document.querySelectorAll('.terminal-dialog-shell[role=dialog]').length,nodeCount:nodes.length,selected:nodes.filter(n=>n.getAttribute('aria-selected')==='true'||n.classList.contains('selected')).map(n=>n.getAttribute('data-id'))}}""")
  # Files tab loads workspace-root files and keeps the same project/worktree header.
  page.locator("#right-sidebar-tab-files").click(); page.get_by_role("tree",name="Workspace files").wait_for(timeout=5000); page.wait_for_timeout(450)
  files=page.evaluate("""()=>({header:document.querySelector('[aria-label=\"Project panel\"] [role=group]')?.getAttribute('aria-label'),files:document.querySelector('[aria-label=\"Project panel\"]')?.innerText.includes('README.md')})""")
  # Switch to main worktree and validate selected-node context changes without opening a terminal dialog.
  mainnode=page.locator('.react-flow__node[data-id="agi-agent-1"]'); b=mainnode.bounding_box(); page.mouse.click(b["x"]+b["width"]*.45,b["y"]+b["height"]*.5); page.wait_for_timeout(250); page.locator("#right-sidebar-tab-changes").click(); page.get_by_role("group",name=re.compile("AGI Paulo.*main")).wait_for(timeout=5000)
  main_header=page.get_by_role("group",name=re.compile("AGI Paulo.*main" )).get_attribute("aria-label")
  # Actual linked SVG edges and markers, plus surface inventory while the pane is open.
  page.mouse.move(1350,20); page.screenshot(path=str(OUT/"canvas-right-sidebar-main-dark-final.png"),full_page=True,animations="disabled")
  wires=page.evaluate("""()=>[...document.querySelectorAll('.react-flow__edge')].map(e=>{const p=e.querySelector('.react-flow__edge-path'),m=p?.getAttribute('marker-end'),id=m?.match(/#([^)]*)/)?.[1],marker=id&&document.getElementById(id),mp=marker?.querySelector('path'),s=p&&getComputedStyle(p);return {pathCount:!!p,stroke:s?.stroke,strokeAttr:p?.getAttribute('stroke'),marker:m,markerFill:mp&&getComputedStyle(mp).fill,markerStroke:mp&&getComputedStyle(mp).stroke}})""")
  materials=page.evaluate("""()=>[...document.querySelectorAll('*')].map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {slot:e.getAttribute('data-slot'),className:typeof e.className==='string'?e.className:'',filter:s.backdropFilter,area:Math.round(r.width*r.height)}}).filter(x=>x.area>0&&x.filter!=='none')""")
  # Focus from an interior sidebar control and close via the documented shortcut.
  page.locator("#app-navigation-sidebar").get_by_role("button",name="Home").focus(); page.keyboard.press("Control+b"); page.wait_for_timeout(350)
  focus_after_close=page.evaluate("""()=>({state:document.querySelector('#app-navigation-sidebar')?.getAttribute('data-state'),activeLabel:document.activeElement?.getAttribute('aria-label'),activeSlot:document.activeElement?.getAttribute('data-slot'),isBody:document.activeElement===document.body,gapWidth:getComputedStyle(document.querySelector('[data-slot=\"sidebar-gap\"]')).width,containerWidth:getComputedStyle(document.querySelector('[data-slot=\"sidebar-container\"]')).width,homeReachable:document.querySelector('[aria-label=\"Workspace navigation\"] button[aria-current=\"page\"]')?.checkVisibility()})""")
  report["cases"].append({"sidebarCollapsed":collapsed,"sidebarReopened":reopened,"accountMenu":menu_open,"pointerHoverEscape":pointer_escape,"keyboardSubmenuOpen":keyboard_submenu_open,"afterArrowLeft":after_arrow_left,"afterEscapeRoot":after_escape_root,"panelRawAfterMenuSequence":panel_raw,"researchChangesContext":changes_context,"researchFilesContext":files,"mainContext":main_header,"wires":wires,"activeFilters":materials,"focusAfterClose":focus_after_close,"pageErrors":errors})
  # Light-mode wire palette on identical actual graph fixture.
  page.evaluate("document.documentElement.classList.remove('dark');document.documentElement.dataset.theme='light'"); page.wait_for_timeout(200); page.screenshot(path=str(OUT/"canvas-wires-light-final.png"),full_page=True,animations="disabled")
  report["cases"][0]["lightWireStyles"]=page.evaluate("""()=>[...document.querySelectorAll('.react-flow__edge-path')].map(e=>({stroke:getComputedStyle(e).stroke,strokeAttr:e.getAttribute('stroke'),marker:e.getAttribute('marker-end')}))""")
  report["cases"][0]["lightChrome"]=page.evaluate("""()=>{const host=document.querySelector('.canvas-chrome-dark'),flow=document.querySelector('.react-flow'),newAgent=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('New agent')),toolbar=document.querySelector('.react-flow__panel button[aria-label^=\"Select\"]'),title=[...document.querySelectorAll('.react-flow__panel span')].find(e=>e.textContent.includes('AGI Paulo')),ta=document.querySelector('textarea');const info=e=>e?{text:e.textContent?.trim().slice(0,70),color:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor,opacity:getComputedStyle(e).opacity,rect:(()=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()}:null;return {rootClass:document.documentElement.className,hostClass:host?.className,flowColor:flow&&getComputedStyle(flow).color,flowForeground:flow&&getComputedStyle(flow).getPropertyValue('--foreground').trim(),flowMuted:flow&&getComputedStyle(flow).getPropertyValue('--muted-foreground').trim(),newAgent:info(newAgent),toolbar:info(toolbar),title:info(title),placeholder:ta&&getComputedStyle(ta,'::placeholder').color,canvasBg:flow&&getComputedStyle(flow).backgroundColor,sidebarBg:getComputedStyle(document.querySelector('[aria-label=\"Project panel\"]')).backgroundColor}}""")
  # A workspace without a session still supplies project-panel context and the right empty state.
  empty_context=browser.new_context(viewport={"width":1440,"height":960})
  empty_context.add_init_script("localStorage.setItem('theme','dark');localStorage.setItem('floq.material','mica');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:"+json.dumps(FIX.USER)+"}));")
  empty_page=empty_context.new_page(); empty_fixture=EmptyWorkspaceFixture(); empty_page.route("**/*",empty_fixture.handle)
  empty_page.goto(report["url"],wait_until="domcontentloaded",timeout=15000); empty_page.get_by_role("heading",name="Start a new task").wait_for(timeout=10000)
  empty_page.get_by_role("button",name="AGI Paulo - SARAH",exact=True).click(); empty_page.get_by_role("button",name="Show project panel").click(); empty_panel=empty_page.get_by_role("complementary",name="Project panel"); empty_panel.wait_for(timeout=5000)
  empty_page.get_by_text("No agent in this workspace",exact=True).first.wait_for(timeout=5000)
  empty_context_header=empty_page.get_by_role("group",name=re.compile("AGI Paulo.*Empty review checkout")).get_attribute("aria-label")
  empty_page.screenshot(path=str(OUT/"canvas-right-sidebar-no-session-final.png"),full_page=True,animations="disabled")
  report["emptyWorkspace"]={"header":empty_context_header,"emptyState":empty_panel.inner_text(),"workspaceInFixtureHasSession":False}
  empty_context.close(); context.close(); browser.close()
 c=report["cases"][0]
 report["assertions"]={
  "sidebarHiddenGapAndNoRail":c["sidebarCollapsed"]["state"]=="collapsed" and c["sidebarCollapsed"]["gap"]["width"]<1 and c["sidebarCollapsed"]["railCount"]==0,
  "sidebarFocusRestoredToTrigger":c["sidebarCollapsed"]["focused"]["slot"]=="sidebar-trigger",
  "collapsedSidebarTabCannotEnterInertNav":c["sidebarCollapsed"]["tabOutsideSidebar"] and c["sidebarCollapsed"]["inert"] and c["sidebarCollapsed"]["ariaHidden"]=="true",
  "keyboardArrowLeftClosesSubmenuThenEscapeClosesRoot":c["keyboardSubmenuOpen"]["root"]==1 and c["keyboardSubmenuOpen"]["sub"]==1 and c["keyboardSubmenuOpen"]["activeInSubmenu"] and c["afterArrowLeft"]["root"]==1 and c["afterArrowLeft"]["sub"]==0 and c["afterEscapeRoot"]["root"]==0 and c["afterEscapeRoot"]["sub"]==0 and not c["afterEscapeRoot"]["bodyScrollLocked"],
  "sidebarShortcutReopens":c["sidebarReopened"]["state"]=="expanded" and c["sidebarReopened"]["homeVisible"],
  "canvasRightPanelSelectedWorktree":c["researchChangesContext"]["viewCanvas"] and "Research pass" in c["researchChangesContext"]["header"] and c["researchChangesContext"]["branchText"] and c["researchChangesContext"]["changeText"] and c["researchChangesContext"]["terminalDialogs"]==0,
  "filesKeepsWorktreeContext": "Research pass" in c["researchFilesContext"]["header"] and c["researchFilesContext"]["files"],
  "selectionSwitchesToMain": "workspace main" in c["mainContext"],
  "threeRealEdgesHaveVisiblePathsAndMarkers":len(c["wires"])==3 and all(w["pathCount"] and w["marker"] for w in c["wires"]),
  "darkWireColorsRecorded":all(w["stroke"]!="none" for w in c["wires"]),
  "noExpandedTerminalDialog":c["researchChangesContext"]["terminalDialogs"]==0,
  "emptyWorkspaceStillNamedWithoutSession":"Empty review checkout" in report["emptyWorkspace"]["header"] and "No agent in this workspace" in report["emptyWorkspace"]["emptyState"],
  "noPageErrors":not c["pageErrors"]}
 report["summary"]={"passed":sum(report["assertions"].values()),"total":len(report["assertions"]),"allPassed":all(report["assertions"].values())}
 (OUT/"canvas-sidebar-final-verification.json").write_text(json.dumps(report,indent=2),encoding="utf-8"); print(json.dumps(report,indent=2))
 if not report["summary"]["allPassed"]: raise SystemExit(1)
if __name__=="__main__":main()






