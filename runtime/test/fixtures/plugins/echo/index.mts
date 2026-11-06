import { definePlugin } from "../../../../dist/plugins/sdk.js";
import { HttpError } from "../../../../dist/errors.js";

export const echoManifest = (over: Record<string, unknown> = {}) => ({
  id: "echo", name: "Echo", version: "1.0.0", apiVersion: 1, tier: "core", description: "Test plugin.", scope: "install",
  secrets: [{ name: "ECHO_TOKEN", required: false }],
  network: { allow: ["api.echo.test", "*.cdn.echo.test"] },
  settings: [{ key: "greeting", type: "text", label: "Greeting", required: false }, { key: "mode", type: "select", label: "Mode", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }],
  contributes: { views: [{ id: "main", label: "Echo" }], routes: true, migrations: true },
  ...over,
});

export interface EchoProbe { starts: number; stops: number; failStarts: number; ctx?: any }

export function makeEcho(probe: EchoProbe = { starts: 0, stops: 0, failStarts: 0 }, manifest: Record<string, unknown> = {}, migrations?: { id: string; sql: string }[]) {
  const plugin = definePlugin({
    manifest: echoManifest(manifest),
    migrations: migrations ?? [{ id: "001_notes", sql: "CREATE TABLE {{p}}notes (user_id TEXT NOT NULL, body TEXT NOT NULL)" }],
    start(ctx) {
      probe.starts++;
      if (probe.failStarts > 0) { probe.failStarts--; throw new Error("boom"); }
      probe.ctx = ctx;
      ctx.routes.get("/ping", ({ userId }) => ({ pong: true, userId }));
      ctx.routes.post("/echo", ({ body }) => ({ body }));
      ctx.routes.get("/items/:id", ({ params, query }) => ({ id: params.id, query }));
      ctx.routes.get("/leak", async ({ userId, query }) => {
        const token = (await ctx.secrets.get(userId, "ECHO_TOKEN")) as string;
        if (query.mode === "throw") throw new Error("GET https://api.echo.test/x?token=" + encodeURIComponent(token) + " failed with " + token);
        if (query.mode === "http") throw new HttpError(418, "teapot", "bad request ?token=" + encodeURIComponent(token) + " / " + JSON.stringify(token).slice(1, -1));
        return { leaked: token, nested: { url: "https://x.test/?token=" + encodeURIComponent(token) } };
      });
      ctx.routes.get("/crash", () => { throw new Error("internal detail"); });
    },
    stop() { probe.stops++; },
  });
  return { plugin, probe };
}
