"""Probe SessionTerminal's retained-scrollback/active-WebSocket behavior.

Uses the synthetic REST fixture from verify-ui.py and a real local WebSocket
server. It never connects to a Floq runtime. Run against the local production
preview with: python scripts/probe-terminal-ws-lifecycle.py --url http://127.0.0.1:1421
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import re
import sys
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
DEPS = Path.home() / "AppData" / "Local" / "Temp" / "floq-ws-lifecycle-deps"
if DEPS.exists():
    sys.path.insert(0, str(DEPS))
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed
from playwright.sync_api import sync_playwright

SPEC = importlib.util.spec_from_file_location("verify_ui", ROOT / "scripts" / "verify-ui.py")
FIXTURES = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(FIXTURES)


class LocalPtyFixture:
    def __init__(self):
        self.loop: asyncio.AbstractEventLoop | None = None
        self.server = None
        self.port = 0
        self.ready = threading.Event()
        self.lock = threading.Lock()
        self.connections: list[dict] = []
        self.history: dict[str, list[dict]] = {x["id"]: [] for x in FIXTURES.SESSIONS}
        self.sequences = {x["id"]: int(x.get("seq", 0)) for x in FIXTURES.SESSIONS}

    async def handler(self, socket):
        parsed = urlparse(socket.request.path)
        chunks = parsed.path.strip("/").split("/")
        if len(chunks) != 4 or chunks[1] != "sessions" or chunks[3] != "stream":
            await socket.close(code=1008, reason="probe accepts session streams only")
            return
        session_id = chunks[2]
        since = int(parse_qs(parsed.query).get("since", ["0"])[0])
        session = next((x for x in FIXTURES.SESSIONS if x["id"] == session_id), FIXTURES.SESSIONS[0])
        record = {"sessionId": session_id, "since": since, "openMs": time.time(), "closeMs": None,
                  "clientMessages": [], "socket": socket}
        with self.lock:
            self.connections.append(record)
            seq = self.sequences.get(session_id, 0)
            history = list(self.history.get(session_id, []))
        hello = {"type": "hello", "server": {"name": "local-test", "version": "1", "startedAt": "2026-01-01T00:00:00Z"},
                 "session": {**session, "seq": seq}, "truncated": 0}
        try:
            await socket.send(json.dumps(hello))
            for frame in history:
                if frame["seq"] > since:
                    await socket.send(json.dumps(frame))
            async for raw in socket:
                try:
                    message = json.loads(raw)
                except (TypeError, ValueError):
                    message = {"raw": str(raw)[:160]}
                with self.lock:
                    record["clientMessages"].append(message)
        except ConnectionClosed:
            pass
        finally:
            with self.lock:
                record["closeMs"] = time.time()

    def start(self):
        def run():
            loop = asyncio.new_event_loop()
            self.loop = loop
            asyncio.set_event_loop(loop)

            async def bind():
                self.server = await serve(self.handler, "127.0.0.1", 0)
                self.port = self.server.sockets[0].getsockname()[1]
                self.ready.set()

            loop.run_until_complete(bind())
            loop.run_forever()
            loop.run_until_complete(self.server.wait_closed())
            loop.close()

        threading.Thread(target=run, name="floq-local-ws", daemon=True).start()
        if not self.ready.wait(5):
            raise RuntimeError("local WebSocket server did not start")

    def stop(self):
        if self.loop and self.server:
            self.loop.call_soon_threadsafe(self.server.close)
            self.loop.call_soon_threadsafe(self.loop.stop)

    def append(self, session_id: str, data: str) -> int:
        with self.lock:
            seq = self.sequences.get(session_id, 0) + 1
            self.sequences[session_id] = seq
            frame = {"type": "output", "seq": seq, "data": data, "ts": int(time.time() * 1000)}
            self.history.setdefault(session_id, []).append(frame)
            sockets = [x["socket"] for x in self.connections if x["sessionId"] == session_id and x["closeMs"] is None]

        async def send_all():
            for socket in sockets:
                try:
                    await socket.send(json.dumps(frame))
                except ConnectionClosed:
                    pass

        assert self.loop
        asyncio.run_coroutine_threadsafe(send_all(), self.loop).result(timeout=3)
        return len(sockets)

    def snapshot(self):
        with self.lock:
            return [{k: v for k, v in record.items() if k != "socket"} for record in self.connections]

    def active(self, session_id: str):
        with self.lock:
            return [x for x in self.connections if x["sessionId"] == session_id and x["closeMs"] is None]


def wait_for(predicate, timeout=8, label="condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise TimeoutError(f"timed out waiting for {label}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:1421")
    args = parser.parse_args()
    fixture = FIXTURES.Fixture()
    server = LocalPtyFixture()
    server.start()
    result = {"url": args.url, "syntheticRuntimeOnly": True, "server": {"host": "127.0.0.1", "port": server.port}, "steps": []}

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 960})
            context.add_init_script("""
              const NativeWebSocket = window.WebSocket;
              window.WebSocket = new Proxy(NativeWebSocket, {construct(target, args) {
                const url = new URL(String(args[0]), location.href);
                if (url.hostname === 'synthetic-runtime.invalid' && url.pathname.startsWith('/v1/sessions/') && url.pathname.endsWith('/stream')) {
                  url.hostname = '127.0.0.1'; url.port = String(__PORT__);
                }
                return Reflect.construct(target, [url.toString(), ...args.slice(1)], target);
              }});
            """.replace("__PORT__", str(server.port)))
            context.add_init_script("localStorage.setItem('theme','dark'); localStorage.setItem('floq.material','mica'); localStorage.setItem('floq.connection', JSON.stringify({baseUrl:'http://synthetic-runtime.invalid',token:'synthetic-token',user:" + json.dumps(FIXTURES.USER) + "}));")
            page = context.new_page()
            page.route("**/*", fixture.handle)
            page.goto(args.url, wait_until="domcontentloaded", timeout=15000)
            page.get_by_role("heading", name="Start a new task").wait_for(timeout=12000)
            nav = page.locator('[aria-label="Workspace navigation"]')
            nav.get_by_role("button", name="AGI Paulo - SARAH", exact=True).click()
            opener = page.get_by_role("button", name=re.compile("Open Outline the evaluation plan"))
            opener.wait_for(timeout=10000)
            opener.click()
            dialog = page.get_by_role("dialog")
            dialog.wait_for(timeout=5000)
            dialog.get_by_role("button", name="Open in full view").click()
            page.locator(".xterm").last.wait_for(state="visible", timeout=10000)
            wait_for(lambda: len(server.active("agi-agent-1")) == 1, label="one active agent stream in full view")
            first_connection = server.active("agi-agent-1")[0]
            wait_for(lambda: any(m.get("type") == "resize" for m in first_connection["clientMessages"]), label="terminal resize message")
            active_first = server.append("agi-agent-1", "\r\nLIFECYCLE_SEQ_1\r\n")
            term = page.locator(".xterm-rows").last
            wait_for(lambda: "LIFECYCLE_SEQ_1" in (term.text_content() or ""), label="first output rendered")
            result["steps"].append({"name": "active stream receives seq 1", "activeConnectionsAtSend": active_first,
                                     "renderedCount": (term.text_content() or "").count("LIFECYCLE_SEQ_1")})

            nav.get_by_role("button", name="Home", exact=True).click()
            page.get_by_role("heading", name="Start a new task").wait_for(timeout=6000)
            wait_for(lambda: len(server.active("agi-agent-1")) == 0, label="socket closes while terminal panel is hidden")
            inactive_second = server.append("agi-agent-1", "\r\nLIFECYCLE_SEQ_2\r\n")
            result["steps"].append({"name": "inactive panel disconnects; output is retained for replay", "activeConnectionsAtSend": inactive_second,
                                     "active": len(server.active("agi-agent-1"))})

            # Return to the same retained terminal through the session's canvas dialog.
            nav.locator('[data-sidebar="menu-button"]').filter(has_text="Outline the evaluation plan").click()
            opener = page.get_by_role("button", name=re.compile("Open Outline the evaluation plan"))
            opener.wait_for(timeout=10000)
            opener.click()
            dialog = page.get_by_role("dialog")
            dialog.wait_for(timeout=5000)
            dialog.get_by_role("button", name="Open in full view").click()
            page.locator(".xterm").last.wait_for(state="visible", timeout=10000)
            wait_for(lambda: len(server.active("agi-agent-1")) == 1, label="single resumed stream")
            resumed = server.active("agi-agent-1")[0]
            wait_for(lambda: any(m.get("type") == "resize" for m in resumed["clientMessages"]), label="resumed terminal resize")
            term = page.locator(".xterm-rows").last
            wait_for(lambda: "LIFECYCLE_SEQ_2" in (term.text_content() or ""), label="missed output replayed")
            text = term.text_content() or ""
            result["steps"].append({"name": "resume starts one stream from last sequence and renders once", "since": resumed["since"],
                                     "seq1Count": text.count("LIFECYCLE_SEQ_1"), "seq2Count": text.count("LIFECYCLE_SEQ_2"),
                                     "activeConnections": len(server.active("agi-agent-1"))})
            result["connections"] = server.snapshot()
            result["passed"] = (result["steps"][0]["activeConnectionsAtSend"] == 1
                                and result["steps"][0]["renderedCount"] == 1
                                and result["steps"][1]["activeConnectionsAtSend"] == 0
                                and result["steps"][2]["since"] == 1
                                and result["steps"][2]["seq1Count"] == 1
                                and result["steps"][2]["seq2Count"] == 1
                                and result["steps"][2]["activeConnections"] == 1)
            context.close()
            browser.close()
    finally:
        server.stop()

    out = ROOT / "docs" / "redesign" / "terminal-ws-lifecycle.json"
    out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": result.get("passed", False), "report": str(out), "steps": result["steps"],
                      "connections": result.get("connections", [])}, indent=2))
    if not result.get("passed"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
