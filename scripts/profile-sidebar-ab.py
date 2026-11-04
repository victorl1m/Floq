"""Same-page, bounded 3×5s sidebar-material A/B on synthetic Floq data.

Diagnostic-only CSS toggles identify blur cost; they never modify product source.
Run: python scripts/profile-sidebar-ab.py
"""
from __future__ import annotations

import importlib.util
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "verify-ui.py")
FIXTURES = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(FIXTURES)
OUT = ROOT / "docs" / "redesign"
OUT.mkdir(parents=True, exist_ok=True)


def sample(page, name: str) -> dict:
    return page.evaluate("""async name=>{const times=[];await new Promise(done=>{let prev,start;const tick=now=>{start??=now;if(prev!==undefined)times.push(now-prev);prev=now;if(now-start<5000)requestAnimationFrame(tick);else done()};requestAnimationFrame(tick)});const s=times.slice().sort((a,b)=>a-b),at=q=>s.length?s[Math.min(s.length-1,Math.floor(s.length*q))]:null;return{name,durationMs:5000,frames:times.length,p50Ms:at(.5),p95Ms:at(.95),over32ms:times.filter(x=>x>32).length,over50ms:times.filter(x=>x>50).length,longTasks:(window.__floqLongTasks||[]).slice(-12)}}""", name)


def surface_profile(page) -> dict:
    return page.evaluate("""() => {const e=document.querySelector('[data-slot="sidebar-inner"]'),s=e&&getComputedStyle(e),q=document.querySelector('.sidebar-search-glass'),qs=q&&getComputedStyle(q),all=[...document.querySelectorAll('.lg-glass')];return {material:document.documentElement.dataset.material,reducedTransparency:matchMedia('(prefers-reduced-transparency: reduce)').matches,base:{filter:s?.backdropFilter,webkit:s?.webkitBackdropFilter,background:s?.backgroundColor,radius:s?.borderRadius},search:{filter:qs?.backdropFilter,webkit:qs?.webkitBackdropFilter,background:qs?.backgroundColor,radius:qs?.borderRadius,hasRim:q?.hasAttribute('data-rim')},glisseSurfaces:all.map(x=>{const r=x.getBoundingClientRect();return{className:String(x.className).slice(0,90),w:Math.round(r.width),h:Math.round(r.height),area:Math.round(r.width*r.height),filter:getComputedStyle(x).backdropFilter}}),glisseButtons:document.querySelectorAll('.lg-button').length}}""")


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 960})
        ctx.add_init_script("window.__floqLongTasks=[];try{new PerformanceObserver(l=>window.__floqLongTasks.push(...l.getEntries().map(e=>({startMs:e.startTime,durationMs:e.duration})))).observe({type:'longtask',buffered:true})}catch{}")
        ctx.add_init_script("localStorage.setItem('theme','dark');localStorage.setItem('floq.material','glass');localStorage.setItem('floq.connection',JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIXTURES.USER) + "}));")
        page = ctx.new_page()
        page.route("**/*", FIXTURES.Fixture().handle)
        page.goto(FIXTURES.BASE, wait_until="domcontentloaded", timeout=15000)
        page.get_by_role("heading", name="Start a new task").wait_for(timeout=10000)
        page.locator('.sidebar-search-glass[data-rim]').wait_for(timeout=5000)
        page.wait_for_timeout(5000)
        normal_css = surface_profile(page)
        page.screenshot(path=str(OUT / "sidebar-ab-normal.png"), full_page=True, animations="disabled")
        normal = sample(page, "normal-material")

        page.add_style_tag(content='html.profile-sidebar-blur-off [data-slot="sidebar-inner"]{backdrop-filter:none!important;-webkit-backdrop-filter:none!important} html.profile-search-glass-off .sidebar-search-glass{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;filter:none!important;background-image:none!important}')
        page.evaluate("document.documentElement.classList.add('profile-sidebar-blur-off')")
        base_off_css = surface_profile(page)
        page.screenshot(path=str(OUT / "sidebar-ab-base-blur-off.png"), full_page=True, animations="disabled")
        base_off = sample(page, "base-sidebar-blur-off")

        page.evaluate("document.documentElement.classList.remove('profile-sidebar-blur-off');document.documentElement.classList.add('profile-search-glass-off')")
        search_off_css = surface_profile(page)
        page.screenshot(path=str(OUT / "sidebar-ab-search-glass-off.png"), full_page=True, animations="disabled")
        search_off = sample(page, "search-glass-filter-off")

        browser_cdp = browser.new_browser_cdp_session()
        gpu = browser_cdp.send("SystemInfo.getInfo").get("gpu", {})
        aux = gpu.get("auxAttributes", {})
        result = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
          "harness": {"viewport": {"width": 1440, "height": 960}, "runtime": "synthetic HTTP responses", "material": "glass", "nativeReducedTransparency": page.evaluate("matchMedia('(prefers-reduced-transparency: reduce)').matches"), "note": "Three sequential 5s samples on the same page; diagnostic CSS toggles only, no source change. Headless WebView surface, no Tauri/GPU workload."},
          "gpu": {"glVendor": aux.get("glVendor"), "glRenderer": aux.get("glRenderer"), "devices": [{k:d.get(k) for k in ("vendorString","deviceString","vendorId","deviceId")} for d in gpu.get("devices",[])]},
          "samples": [{"before": normal, "css": normal_css}, {"sidebarBaseBlurOff": base_off, "css": base_off_css}, {"searchGlassFilterOff": search_off, "css": search_off_css}],
          "longTasks": page.evaluate("window.__floqLongTasks")}
        destination = OUT / "ui-performance-sidebar-ab.json"
        destination.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, indent=2))
        browser.close()


if __name__ == "__main__":
    main()
