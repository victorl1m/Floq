"""Focused, synthetic-only frosting and focus verification for account/menu/dialog surfaces."""
from __future__ import annotations
import importlib.util, json, os, re
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "verify-ui.py")
FIXTURES = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(FIXTURES)
OUT = ROOT / "docs" / "redesign"
OUT.mkdir(parents=True, exist_ok=True)
URL = os.environ.get("FLOQ_UI_URL", "http://127.0.0.1:1421/")
LABEL = os.environ.get("FLOQ_FROSTED_LABEL", "production")


def surface_snapshot(page, surface_selector: str, overlay_selector: str | None = None) -> dict:
    return page.evaluate("""({surfaceSelector, overlaySelector}) => {
      const el=document.querySelector(surfaceSelector),o=overlaySelector&&document.querySelector(overlaySelector);
      const info=e=>{if(!e)return null;const s=getComputedStyle(e),r=e.getBoundingClientRect(),items=[...e.querySelectorAll('[role="menuitem"]')].slice(0,3);return {slot:e.getAttribute('data-slot'),role:e.getAttribute('role'),className:typeof e.className==='string'?e.className:null,background:s.backgroundColor,backgroundImage:s.backgroundImage,border:s.border,borderRadius:s.borderRadius,boxShadow:s.boxShadow,backdropFilter:s.backdropFilter,webkitBackdropFilter:s.getPropertyValue('-webkit-backdrop-filter'),filter:s.filter,opacity:s.opacity,textSamples:items.map(x=>({text:x.textContent?.trim().slice(0,70),color:getComputedStyle(x).color,opacity:getComputedStyle(x).opacity})),rect:{x:r.x,y:r.y,width:r.width,height:r.height},inViewport:r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1}};
      const matched=[];function walk(rules){for(const r of rules){if(r.cssRules)walk(r.cssRules);if(r.selectorText&&el&&r.style&&el.matches(r.selectorText)){const bf=r.style.getPropertyValue('backdrop-filter')||r.style.getPropertyValue('-webkit-backdrop-filter');if(bf)matched.push({selector:r.selectorText,filter:bf,important:r.style.getPropertyPriority('backdrop-filter')||r.style.getPropertyPriority('-webkit-backdrop-filter')})}}}for(const ss of document.styleSheets){try{walk(ss.cssRules)}catch{}}
      const sheets=[...document.styleSheets].map(ss=>{try{return {href:ss.href,disabled:ss.disabled,ruleCount:ss.cssRules.length}}catch(e){return {href:ss.href,error:String(e)}}});
      const activeFilters=[...document.querySelectorAll('*')].map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {tag:e.tagName,slot:e.getAttribute('data-slot'),className:typeof e.className==='string'?e.className:'',filter:s.backdropFilter,rect:{width:Math.round(r.width),height:Math.round(r.height),area:Math.round(r.width*r.height)}}}).filter(x=>x.rect.area>0&&x.filter!=='none');
      return {surface:info(el),overlay:info(o),material:document.documentElement.dataset.material,reducedTransparency:matchMedia('(prefers-reduced-transparency: reduce)').matches,backdropFilterSupported:CSS.supports('backdrop-filter','blur(1px)'),webkitBackdropFilterSupported:CSS.supports('-webkit-backdrop-filter','blur(1px)'),matchedFilterRules:matched,styleSheets:sheets,activeFilters};
    }""", {"surfaceSelector": surface_selector, "overlaySelector": overlay_selector})


def open_user_menu(page):
    trigger = page.get_by_role("button", name="Avery Example")
    if not trigger.is_visible():
        page.get_by_role("button", name=re.compile("Show navigation|Toggle Sidebar", re.I)).first.click()
        page.get_by_role("dialog", name="Sidebar").wait_for(state="visible", timeout=4000)
        trigger.wait_for(state="visible", timeout=4000)
    trigger.click()
    menu = page.locator('[data-slot="dropdown-menu-content"]').filter(has=page.get_by_role("menuitem", name="Settings")).last
    menu.wait_for(state="visible", timeout=5000)
    page.wait_for_timeout(300)
    return trigger, menu


def inspect_case(browser, theme: str, viewport: dict[str, int], case: str) -> dict:
    context = browser.new_context(viewport=viewport)
    context.add_init_script("localStorage.setItem('theme'," + json.dumps(theme) + "); localStorage.setItem('floq.material','mica'); localStorage.setItem('floq.connection', JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIXTURES.USER) + "}));")
    page = context.new_page()
    fixture = FIXTURES.Fixture()
    page.route("**/*", fixture.handle)
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL, wait_until="domcontentloaded", timeout=15000)
    page.get_by_role("heading", name="Start a new task").wait_for(timeout=10000)
    page.evaluate("document.fonts.ready")
    menu_trigger, menu = open_user_menu(page)
    menu_info = surface_snapshot(page, '[data-slot="dropdown-menu-content"]:not([data-state="closed"])')
    page.screenshot(path=str(OUT / f"frosted-account-menu-{case}-{LABEL}.png"), full_page=True, animations="disabled")
    menu_rect = menu.bounding_box()
    # Exercise keyboard dismissal, focus restoration, then reopen through the menu item to Settings.
    page.keyboard.press("Escape")
    page.wait_for_timeout(250)
    menu_focus = page.evaluate("""() => ({activeTag:document.activeElement?.tagName,activeLabel:document.activeElement?.getAttribute('aria-label'),activeText:document.activeElement?.textContent?.trim().slice(0,70),scrollLocked:document.body.hasAttribute('data-scroll-locked'),openMenus:[...document.querySelectorAll('[data-slot="dropdown-menu-content"][data-state="open"]')].length})""")
    menu_focus["triggerRestored"] = menu_trigger.evaluate("e => document.activeElement === e")
    menu_trigger.focus()
    page.keyboard.press("Enter")
    keyboard_opened = page.get_by_role("menuitem", name="Settings").is_visible(timeout=3000)
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    # Reopen with pointer and enter the actual Settings flow.
    menu_trigger.click()
    page.get_by_role("menuitem", name="Appearance").click()
    dialog = page.get_by_role("dialog")
    dialog.wait_for(state="visible", timeout=6000)
    page.wait_for_timeout(350)
    dialog_info = surface_snapshot(page, '[data-slot="dialog-content"]', '[data-slot="dialog-overlay"]')
    dialog_focus = page.evaluate("""() => {const a=document.activeElement,d=a?.closest('[role="dialog"]');return {activeTag:a?.tagName,activeLabel:a?.getAttribute('aria-label'),activeRole:a?.getAttribute('role'),focusInsideDialog:!!d,focusVisible:a?.matches(':focus-visible')}}""")
    page.screenshot(path=str(OUT / f"frosted-settings-{case}-{LABEL}.png"), full_page=True, animations="disabled")
    page.keyboard.press("Escape")
    page.wait_for_timeout(250)
    if case == "light-narrow":
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)
    dialog_close = page.evaluate("""() => ({remainingDialogs:document.querySelectorAll('[role="dialog"]').length,scrollLocked:document.body.hasAttribute('data-scroll-locked'),activeTag:document.activeElement?.tagName,activeLabel:document.activeElement?.getAttribute('aria-label')})""")
    result = {"case": case, "theme": theme, "viewport": viewport, "accountMenu": menu_info, "menuBounds": menu_rect, "menuKeyboardOpened": keyboard_opened, "menuAfterEscape": menu_focus, "settingsDialog": dialog_info, "dialogFocus": dialog_focus, "dialogAfterEscape": dialog_close, "pageErrors": errors, "assertions": {"menuBlurVisible": bool(menu_info['surface'] and 'blur(' in menu_info['surface']['backdropFilter']), "dialogBlurVisible": bool(dialog_info['surface'] and 'blur(' in dialog_info['surface']['backdropFilter']), "overlayBlurOff": bool(dialog_info['overlay'] and dialog_info['overlay']['backdropFilter'] == 'none'), "menuWithinViewport": bool(menu_rect and menu_rect['x'] >= 0 and menu_rect['y'] >= 0 and menu_rect['x'] + menu_rect['width'] <= viewport['width'] + 1 and menu_rect['y'] + menu_rect['height'] <= viewport['height'] + 1), "menuEscapeRestoresFocus": menu_focus['triggerRestored'] and menu_focus['openMenus'] == 0, "dialogFocusTrapped": dialog_focus['focusInsideDialog'], "dialogEscapeCloses": dialog_close['remainingDialogs'] == 0 and not dialog_close['scrollLocked']}}
    context.close()
    return result


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        results = [inspect_case(browser, theme, {"width": 1440, "height": 960}, theme) for theme in ("dark", "light")]
        narrow = inspect_case(browser, "light", {"width": 390, "height": 844}, "light-narrow")
        results.append(narrow)
        browser.close()
    report = {"url": URL, "syntheticRuntimeOnly": True, "cases": results, "summary": {"caseCount": len(results), "assertionsPassed": sum(sum(case["assertions"].values()) for case in results), "assertionsTotal": sum(len(case["assertions"]) for case in results), "allPassed": all(all(case["assertions"].values()) and not case["pageErrors"] for case in results)}}
    print(json.dumps(report, indent=2))
    (OUT / f"frosted-surfaces-{LABEL}-verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    if not report["summary"]["allPassed"]: raise SystemExit(1)


if __name__ == "__main__":
    main()

