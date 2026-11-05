"""Bounded Chromium performance profile for Floq's browser WebView surface.

Uses only synthetic runtime fixtures from verify-ui.py. rAF/main-thread numbers are
diagnostic and do not measure native Tauri or hardware GPU performance.
Run: python scripts/profile-ui.py --label before
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "verify-ui.py")
FIXTURES = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(FIXTURES)


def frame_sample(page, name: str, duration_ms: int = 700) -> dict:
    return page.evaluate("""async ({name, duration}) => {
      const intervals = [];
      await new Promise(resolve => {
        let previous;
        const start = performance.now();
        const tick = now => {
          if (previous !== undefined) intervals.push(now - previous);
          previous = now;
          if (now - start < duration) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      const sorted = intervals.slice().sort((a, b) => a - b);
      const at = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null;
      return {name, durationMs: duration, frames: intervals.length, p50Ms: at(.5), p95Ms: at(.95),
        over32ms: intervals.filter(x => x > 32).length, over50ms: intervals.filter(x => x > 50).length,
        longTasks: (window.__floqLongTasks || []).slice(-12)};
    }""", {"name": name, "duration": duration_ms})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", default="current", help="evidence label, e.g. before or after")
    parser.add_argument("--url", default=FIXTURES.BASE)
    parser.add_argument("--settle-ms", type=int, default=5000, help="warm-up/idle window before samples")
    parser.add_argument("--disable-translucency", action="store_true", help="diagnostic CSS-only A/B; no product source changes")
    parser.add_argument("--sidebar-material-ab", action="store_true", help="same-page diagnostic: disable base sidebar blur, then compact search only")
    parser.add_argument("--material", choices=("mica", "acrylic", "solid"), default="mica")
    parser.add_argument("--reduce-transparency", action="store_true", help="emulate OS reduced-transparency only for the explicit fallback check")
    args = parser.parse_args()
    fixture = FIXTURES.Fixture()
    output_dir = ROOT / "docs" / "redesign"
    output_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        browser_info = {"available": False}
        try:
            browser_cdp = browser.new_browser_cdp_session()
            info = browser_cdp.send("SystemInfo.getInfo")
            gpu = info.get("gpu", {})
            aux = gpu.get("auxAttributes", {})
            browser_info = {
                "available": True,
                "glVendor": aux.get("glVendor"),
                "glRenderer": aux.get("glRenderer"),
                "glVersion": aux.get("glVersion"),
                "angleBackend": aux.get("angleBackend"),
                "softwareRendering": aux.get("softwareRendering"),
                "devices": [{k: d.get(k) for k in ("vendorString", "deviceString", "vendorId", "deviceId", "driverVendor", "driverVersion")} for d in gpu.get("devices", [])],
            }
        except Exception as exc:
            browser_info = {"available": False, "error": str(exc)}
        context = browser.new_context(viewport={"width": 1440, "height": 960})
        context.add_init_script("""
          window.__floqLongTasks = [];
          try { new PerformanceObserver(list => window.__floqLongTasks.push(...list.getEntries().map(e => ({startMs:e.startTime,durationMs:e.duration}))))
            .observe({type:'longtask', buffered:true}); } catch {}
          window.__floqSocketTracker = [];
          try {
            const NativeWebSocket = window.WebSocket;
            window.WebSocket = new Proxy(NativeWebSocket, {construct(target, args) {
              const socket = Reflect.construct(target, args, target);
              let parsed;
              try { parsed = new URL(String(args[0]), location.href); } catch {}
              const item = {url: parsed ? parsed.origin + parsed.pathname : String(args[0]).split('?')[0], since: parsed?.searchParams.get('since') ?? null,
                createdMs: performance.now(), openedMs: null, closedMs: null, closeCode: null};
              window.__floqSocketTracker.push(item);
              socket.addEventListener('open', () => { item.openedMs = performance.now(); });
              socket.addEventListener('close', event => { item.closedMs = performance.now(); item.closeCode = event.code; });
              return socket;
            }});
          } catch {}
        """)
        if args.disable_translucency:
            context.add_init_script("""
              const installGlassDiagnostic = () => {
                if (!document.head || document.getElementById('floq-glass-diagnostic')) return;
                const style = document.createElement('style');
                style.id = 'floq-glass-diagnostic';
                style.textContent = '.floq-glass,.glass-panel{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;filter:none!important;background-image:none!important}';
                document.head.append(style);
              };
              installGlassDiagnostic();
              document.addEventListener('DOMContentLoaded', installGlassDiagnostic, {once:true});
            """)
        context.add_init_script("localStorage.setItem('theme','dark'); localStorage.setItem('floq.material'," + json.dumps(args.material) + "); localStorage.setItem('floq.connection', JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIXTURES.USER) + "}));")
        page = context.new_page()
        page.route("**/*", fixture.handle)
        page_websockets: list[dict] = []

        def on_page_websocket(socket) -> None:
            parsed = urlparse(socket.url)
            record = {"url": parsed.scheme + "://" + parsed.netloc + parsed.path, "since": parse_qs(parsed.query).get("since", [None])[0], "closed": False}
            page_websockets.append(record)
            try:
                socket.on("close", lambda *_args: record.update(closed=True))
            except Exception:
                pass

        page.on("websocket", on_page_websocket)
        cdp = context.new_cdp_session(page)
        cdp.send("Performance.enable")
        cdp.send("Network.enable")
        if args.reduce_transparency:
            cdp.send("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-reduced-transparency", "value": "reduce"}]})
        websocket_network_events = {"created": [], "closed": []}
        cdp.on("Network.webSocketCreated", lambda ev: websocket_network_events["created"].append({"requestId": ev.get("requestId"), "url": ev.get("url", "").split("?", 1)[0]}))
        cdp.on("Network.webSocketClosed", lambda ev: websocket_network_events["closed"].append({"requestId": ev.get("requestId"), "timestamp": ev.get("timestamp")}))
        websocket_stats = {"connections": 0, "sessionIds": [], "outputFrames": 0, "outputBytes": 0, "outputTargetSessionId": None, "clientMessages": []}
        websocket_routes = []
        server_seq = {item["id"]: int(item.get("seq", 0)) for item in FIXTURES.SESSIONS}
        server_history = {item["id"]: [] for item in FIXTURES.SESSIONS}

        def mock_terminal_stream(route) -> None:
            parsed = urlparse(route.url)
            session_id = parsed.path.rstrip("/").split("/")[-2]
            since = int(parse_qs(parsed.query).get("since", ["0"])[0])
            session = next((item for item in FIXTURES.SESSIONS if item["id"] == session_id), FIXTURES.SESSIONS[0])
            record = {"route": route, "sessionId": session_id, "since": since, "closed": False, "messages": 0}
            websocket_routes.append(record)
            websocket_stats["connections"] += 1
            websocket_stats["sessionIds"].append(session_id)
            log_record = {"sessionId": session_id, "since": since}
            hello_session = {**session, "seq": server_seq.get(session_id, 0)}
            hello = json.dumps({"type": "hello", "session": hello_session})
            route.send(hello)
            for frame in server_history.get(session_id, []):
                if frame["seq"] > since:
                    route.send(json.dumps(frame))
            def on_message(message):
                record["messages"] += 1
                websocket_stats["clientMessages"].append(str(message)[:160])
            route.on_message(on_message)

        # This is a bounded, isolated PTY stream: hello only at connect, then a 120-line burst after idle sampling.
        page.route_web_socket("**/v1/sessions/*/stream*", mock_terminal_stream)
        page.goto(args.url, wait_until="domcontentloaded", timeout=15000)
        page.get_by_role("heading", name="Start a new task").wait_for(timeout=10000)
        if args.settle_ms:
            page.wait_for_timeout(args.settle_ms)
        page.screenshot(path=str(output_dir / f"home-profile-{args.label}.png"), full_page=True, animations="disabled")
        cdp.send("Profiler.enable")
        cdp.send("Profiler.start")
        metrics_of_interest = {"TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskOtherDuration", "JSHeapUsedSize"}

        def metrics() -> dict:
            return {m["name"]: m["value"] for m in cdp.send("Performance.getMetrics")["metrics"] if m["name"] in metrics_of_interest}

        def stream_routes_snapshot() -> dict:
            routes = [{"sessionId": item["sessionId"], "since": item["since"], "clientMessages": item["messages"]} for item in websocket_routes]
            stream_sockets = [item for item in page_websockets if "/v1/sessions/" in item["url"] and item["url"].endswith("/stream")]
            active_sockets = [item for item in stream_sockets if not item["closed"]]
            ids = sorted({urlparse(item["url"]).path.strip("/").split("/")[-2] for item in stream_sockets})
            return {"fixtureRoutes": routes, "clientSockets": stream_sockets, "openBySession": {sid: sum(1 for item in active_sockets if f"/v1/sessions/{sid}/stream" in item["url"]) for sid in ids}}

        samples = [frame_sample(page, "home-idle")]
        page.mouse.move(1300, 20)
        page.mouse.wheel(0, 380)
        samples.append(frame_sample(page, "home-scroll"))
        project_session = page.get_by_role("button", name=__import__("re").compile("Outline the evaluation plan"))
        if project_session.count():
            project_session.first.hover()
            samples.append(frame_sample(page, "sidebar-agent-hover", 500))

        before_tasks = metrics()
        started = time.perf_counter()
        page.get_by_role("button", name="Tasks").click()
        page.get_by_text("Review onboarding", exact=True).wait_for(timeout=8000)
        tasks_elapsed = (time.perf_counter() - started) * 1000
        tasks_metrics = metrics()
        samples.append(frame_sample(page, "tasks-navigation"))

        page.get_by_role("button", name="Home").click()
        page.get_by_role("heading", name="Start a new task").wait_for(timeout=5000)
        started = time.perf_counter()
        page.get_by_role("button", name="AGI Paulo - SARAH", exact=True).click()
        page.get_by_role("button", name="Open Outline the evaluation plan").wait_for(timeout=10000)
        canvas_elapsed = (time.perf_counter() - started) * 1000
        page.screenshot(path=str(output_dir / f"canvas-profile-{args.label}.png"), full_page=True, animations="disabled")
        samples.append(frame_sample(page, "canvas-open"))

        # Profile the newly frosted project pane with an actual selected agent context.
        research_node = page.locator('.react-flow__node[data-id="agi-agent-2"]')
        if research_node.count():
            research_box = research_node.bounding_box()
            if research_box:
                page.mouse.click(research_box["x"] + research_box["width"] * .45, research_box["y"] + research_box["height"] * .5)
        project_panel_button = page.get_by_role("button", name="Show project panel")
        if project_panel_button.count():
            project_panel_button.click()
            page.get_by_role("complementary", name="Project panel").wait_for(timeout=5000)
            page.wait_for_timeout(300)
            page.screenshot(path=str(output_dir / f"canvas-right-panel-profile-{args.label}.png"), full_page=True, animations="disabled")
            samples.append(frame_sample(page, "canvas-right-panel-frosted-idle-5s", 5000))
            project_panel_material = page.evaluate("""() => {const p=document.querySelector('[aria-label=\"Project panel\"]'),s=p&&getComputedStyle(p);return {material:document.documentElement.dataset.material,panelFilter:s?.backdropFilter,panelBackground:s?.backgroundColor,overlayFilter:document.querySelector('[data-slot=\"dialog-overlay\"]')?getComputedStyle(document.querySelector('[data-slot=\"dialog-overlay\"]')).backdropFilter:null,area:p?Math.round(p.getBoundingClientRect().width*p.getBoundingClientRect().height):0}}""")
            try:
                page.get_by_role("button", name="Avery Example").click(timeout=1500)
                page.get_by_role("menuitem", name="Appearance").click(timeout=2500)
                page.get_by_role("dialog").wait_for(timeout=5000)
                page.wait_for_timeout(250)
                page.screenshot(path=str(output_dir / f"canvas-settings-profile-{args.label}.png"), full_page=True, animations="disabled")
                samples.append(frame_sample(page, "canvas-settings-dialog-frosted-idle-5s", 5000))
                project_panel_material["settingsDialogFilter"] = page.evaluate("getComputedStyle(document.querySelector('[data-slot=\"dialog-content\"]')).backdropFilter")
                project_panel_material["settingsOverlayFilter"] = page.evaluate("getComputedStyle(document.querySelector('[data-slot=\"dialog-overlay\"]')).backdropFilter")
                page.keyboard.press("Escape"); page.wait_for_timeout(200)
            except Exception as exc:
                project_panel_material["settingsDialogProbeError"] = str(exc)
            page.get_by_role("button", name="Hide project panel").click(timeout=3000)
        else:
            project_panel_material = {"probeError": "Show project panel titlebar action not present"}

        pane = page.locator(".react-flow__pane").first
        pane_box = pane.bounding_box()
        pan_started = time.perf_counter()
        if pane_box:
            x, y = pane_box["x"] + pane_box["width"] * .7, pane_box["y"] + pane_box["height"] * .7
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x - 120, y - 70, steps=3)
            page.mouse.up()
        pan_elapsed = (time.perf_counter() - pan_started) * 1000
        samples.append(frame_sample(page, "canvas-pan"))

        started = time.perf_counter()
        page.get_by_role("button", name="Open Outline the evaluation plan").click()
        page.get_by_role("dialog").wait_for(timeout=5000)
        terminal_open_elapsed = (time.perf_counter() - started) * 1000
        page.locator('[role="dialog"] .xterm').first.wait_for(state="attached", timeout=8000)
        page.wait_for_timeout(300)
        terminal_metrics_before_frames = metrics()
        samples.append(frame_sample(page, "expanded-terminal-first-700ms", 700))
        samples.append(frame_sample(page, "expanded-terminal-idle-5s", 5000))
        output_lines = [f"synthetic output line {i:04d} | bounded browser fixture | terminal render sample" for i in range(1, 2001)]
        output_frame_object = {"type": "output", "seq": 1, "data": "\r\n" + "\r\n".join(output_lines) + "\r\n"}
        output_frame = json.dumps(output_frame_object)
        target_route = next((item for item in reversed(websocket_routes) if item["sessionId"] == "agi-agent-1"), None)
        if target_route:
            target_route["route"].send(output_frame)
            websocket_stats["outputFrames"] = 1
            websocket_stats["outputBytes"] = len(output_frame.encode("utf-8"))
            websocket_stats["outputTargetSessionId"] = target_route["sessionId"]
            server_seq["agi-agent-1"] = 1
            server_history["agi-agent-1"].append(output_frame_object)
            page.wait_for_timeout(250)
        else:
            websocket_stats["fixtureError"] = "SessionTerminal did not open a mocked stream socket for agi-agent-1"
        websocket_stats["visibleTextContainsFinalLine"] = page.evaluate("document.querySelector('[role=dialog] .xterm-rows')?.textContent?.includes('synthetic output line 2000') || false")
        websocket_stats["visibleFinalLineCount"] = page.evaluate("(document.querySelector('[role=dialog] .xterm-rows')?.textContent?.match(/synthetic output line 2000/g)||[]).length")
        samples.append(frame_sample(page, "expanded-terminal-after-2000-line-burst-5s", 5000))
        terminal_metrics_after_frames = metrics()
        terminal_geometry = page.evaluate("""() => {const d=document.querySelector('[role=dialog]'),h=d?.firstElementChild,t=d?.lastElementChild,x=document.querySelector('[role=dialog] .xterm'),v=x?.querySelector('.xterm-viewport'),xs=x?.querySelector('.xterm-screen'),s=d&&getComputedStyle(d),ts=t&&getComputedStyle(t),xcs=x&&getComputedStyle(x),vs=v&&getComputedStyle(v),xss=xs&&getComputedStyle(xs),all=[...document.querySelectorAll('.xterm')];const r=e=>{const b=e?.getBoundingClientRect();return b&&{x:b.x,y:b.y,width:b.width,height:b.height}};return {dialog:r(d),toolbar:r(h),terminal:r(t),dialogRadius:s?.borderRadius,dialogBackdrop:s?.backdropFilter,dialogBackground:s?.backgroundColor,terminalBackground:ts?.backgroundColor,terminalBackdrop:ts?.backdropFilter,xtermRootsInDialog:document.querySelectorAll('[role=dialog] .xterm').length,xtermRootsTotal:all.length,xtermRoots:all.map(e=>({visible:e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0,rect:r(e),background:getComputedStyle(e).backgroundColor})),xterm:{background:xcs?.backgroundColor,allowTransparency:x?.getAttribute('data-allow-transparency')||null,viewportBackground:vs?.backgroundColor,screenBackground:xss?.backgroundColor,canvasCount:x?.querySelectorAll('canvas').length},toolbarCenterY:h?Math.round((h.getBoundingClientRect().top+h.getBoundingClientRect().bottom)/2):null,terminalTitle:document.querySelector('[role=dialog] [title*=Orchestrator]')?.getAttribute('title')||null,material:document.documentElement.dataset.material}}""")
        page.screenshot(path=str(output_dir / f"terminal-dialog-{args.label}.png"), full_page=True, animations="disabled")
        sidebar_ab = None
        if args.sidebar_material_ab:
            page.add_style_tag(content='html.profile-sidebar-blur-off [data-slot="sidebar-inner"]{backdrop-filter:none!important;-webkit-backdrop-filter:none!important} html.profile-search-glass-off .sidebar-search-glass{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;filter:none!important;background-image:none!important}')
            page.evaluate("document.documentElement.classList.add('profile-sidebar-blur-off')")
            sidebar_off = frame_sample(page, "same-page-sidebar-base-blur-off-5s", 5000)
            sidebar_css_off = page.evaluate("""() => {const e=document.querySelector('[data-slot="sidebar-inner"]'),s=e&&getComputedStyle(e),q=document.querySelector('.sidebar-search-glass'),qs=q&&getComputedStyle(q);return {base:s?.backdropFilter,search:qs?.backdropFilter,material:document.documentElement.dataset.material}}""")
            page.evaluate("document.documentElement.classList.remove('profile-sidebar-blur-off');document.documentElement.classList.add('profile-search-glass-off')")
            search_off = frame_sample(page, "same-page-search-glass-filter-off-5s", 5000)
            search_css_off = page.evaluate("""() => {const e=document.querySelector('[data-slot="sidebar-inner"]'),s=e&&getComputedStyle(e),q=document.querySelector('.sidebar-search-glass'),qs=q&&getComputedStyle(q);return {base:s?.backdropFilter,search:qs?.backdropFilter,material:document.documentElement.dataset.material}}""")
            sidebar_ab = {"sidebarBlurOff": {"sample": sidebar_off, "computed": sidebar_css_off}, "searchGlassOff": {"sample": search_off, "computed": search_css_off}}
        terminal_lifecycle = {"attempted": False}
        try:
            page.get_by_role("button", name="Open in full view").click(timeout=1000)
            page.locator(".xterm").first.wait_for(timeout=5000)
            page.wait_for_timeout(500)
            in_full_view = page.evaluate("""() => {const streams=(window.__floqSocketTracker||[]).filter(x=>x.url.includes('/v1/sessions/')&&x.url.endsWith('/stream'));return {streams:streams.map(x=>({url:x.url,opened:x.openedMs!==null,closed:x.closedMs!==null,since:x.since})),liveForTarget:streams.filter(x=>x.url.includes('/v1/sessions/agi-agent-1/stream')&&x.closedMs===null).length,xterms:document.querySelectorAll('.xterm').length,outputLineCount:(document.querySelector('.xterm-rows')?.textContent?.match(/synthetic output line 2000/g)||[]).length}}""")
            in_full_view["socketState"] = stream_routes_snapshot()
            page.get_by_role("button", name="Tasks").click()
            page.get_by_text("Review onboarding", exact=True).wait_for(timeout=8000)
            page.wait_for_timeout(400)
            away = page.evaluate("""() => {const streams=(window.__floqSocketTracker||[]).filter(x=>x.url.includes('/v1/sessions/')&&x.url.endsWith('/stream'));return {streams:streams.map(x=>({url:x.url,opened:x.openedMs!==null,closed:x.closedMs!==null,since:x.since})),liveForTarget:streams.filter(x=>x.url.includes('/v1/sessions/agi-agent-1/stream')&&x.closedMs===null).length,xterms:document.querySelectorAll('.xterm').length,outputLineCount:(document.querySelector('.xterm-rows')?.textContent?.match(/synthetic output line 2000/g)||[]).length}}""")
            away["socketState"] = stream_routes_snapshot()
            target_open_away = away["socketState"]["openBySession"].get("agi-agent-1", 0)
            terminal_lifecycle = {"attempted": True, "canvasDialog": stream_routes_snapshot(), "fullView": in_full_view, "afterNavigatingAway": away,
                "inactiveStreamClosed": target_open_away == 0,
                "fullViewOutputPresentOnce": in_full_view["outputLineCount"] == 1}
        except Exception as exc:
            terminal_lifecycle = {"attempted": True, "error": str(exc)}
        closed_ids = {item["requestId"] for item in websocket_network_events["closed"]}
        by_session: dict[str, dict[str, int]] = {}
        for item in websocket_network_events["created"]:
            parts = urlparse(item["url"]).path.strip("/").split("/")
            sid = parts[-2] if len(parts) >= 3 and parts[-3] == "sessions" else "other"
            entry = by_session.setdefault(sid, {"created": 0, "closed": 0})
            entry["created"] += 1
            if item["requestId"] in closed_ids:
                entry["closed"] += 1
        active_websockets = {"created": len(websocket_network_events["created"]), "closed": len(websocket_network_events["closed"]), "openEstimate": len(websocket_network_events["created"]) - len(websocket_network_events["closed"]), "bySession": by_session, "createdUrls": websocket_network_events["created"]}
        client_streams = stream_routes_snapshot()
        profile = cdp.send("Profiler.stop").get("profile", {})
        nodes = {node["id"]: node for node in profile.get("nodes", [])}
        hits: dict[tuple[str, str, int], int] = {}
        for node_id in profile.get("samples", []):
            node = nodes.get(node_id, {})
            frame = node.get("callFrame", {})
            key = (frame.get("url", ""), frame.get("functionName", "(anonymous)"), frame.get("lineNumber", 0))
            hits[key] = hits.get(key, 0) + 1
        top_cpu_samples = [{"url": k[0], "function": k[1], "line": k[2], "samples": v} for k, v in sorted(hits.items(), key=lambda item: item[1], reverse=True)[:15]]

        result = {
            "label": args.label,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "harness": {"browser": "Chromium headless via Playwright", "viewport": {"width": 1440, "height": 960}, "runtime": "synthetic HTTP + intercepted terminal WebSocket fixtures only", "nativeReducedTransparency": page.evaluate("matchMedia('(prefers-reduced-transparency: reduce)').matches"), "material": args.material, "settleMs": args.settle_ms, "cssDiagnosticTranslucencyDisabled": args.disable_translucency, "note": "rAF and CDP numbers profile the browser WebView surface only; no native Tauri or GPU/hardware measurement."},
            "browserGpuInfo": browser_info,
            "navigationElapsedMs": {"tasks": round(tasks_elapsed, 1), "canvas": round(canvas_elapsed, 1), "terminalDialog": round(terminal_open_elapsed, 1), "canvasPan": round(pan_elapsed, 1)},
            "samples": samples,
            "taskMetricDeltaBeforeTerminal": {k: round(tasks_metrics.get(k, 0) - before_tasks.get(k, 0), 6) for k in before_tasks},
            "terminalMetricDeltaDuringRafSample": {k: round(terminal_metrics_after_frames.get(k, 0) - terminal_metrics_before_frames.get(k, 0), 6) for k in terminal_metrics_before_frames},
            "terminalGeometry": terminal_geometry,
            "canvasProjectPanelMaterial": project_panel_material,
            "websocketFixture": {**websocket_stats, "routeLog": [{"sessionId": item["sessionId"], "since": item["since"], "clientMessages": item["messages"]} for item in websocket_routes]},
            "websocketNetworkEvents": active_websockets,
            "clientStreamTracker": client_streams,
            "terminalLifecycle": terminal_lifecycle,
            "samePageMaterialAb": sidebar_ab,
            "topCpuSamples": top_cpu_samples,
            "longTasksTotal": page.evaluate("window.__floqLongTasks.length"),
            "longTasks": page.evaluate("window.__floqLongTasks"),
        }
        destination = output_dir / f"ui-performance-{args.label}.json"
        destination.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, indent=2))
        browser.close()


if __name__ == "__main__":
    main()
