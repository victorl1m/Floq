import assert from "node:assert/strict";
import test from "node:test";
import { getIP } from "@better-auth/core/utils/ip";
import { AUTH_IP_ADDRESS } from "../dist/auth.js";
import { clientIp, normalizeAuthForwardedHeaders } from "../dist/clientIp.js";

// What better-auth would use as the rate-limit key for a request, after the server's header normalization.
function authSeesIp(headers: Record<string, string>, remoteAddress: string, env: NodeJS.ProcessEnv): string | null {
  const req = { headers: { ...headers }, socket: { remoteAddress } } as never as Parameters<typeof clientIp>[0];
  normalizeAuthForwardedHeaders(req, env);
  const flat = new Headers(Object.entries(req.headers as Record<string, string>));
  return getIP(flat, { advanced: { ipAddress: AUTH_IP_ADDRESS } } as never);
}

test("a forged X-Forwarded-For reaches better-auth as the socket address when FLOQ_TRUST_PROXY is unset", () => {
  assert.equal(authSeesIp({ "x-forwarded-for": "1.2.3.4" }, "203.0.113.9", {}), "203.0.113.9");
  assert.equal(authSeesIp({ "x-forwarded-for": "1.2.3.4, 5.6.7.8", "x-real-ip": "9.9.9.9" }, "203.0.113.9", {}), "203.0.113.9");
  assert.equal(authSeesIp({ "x-forwarded-for": "1.2.3.4" }, "203.0.113.9", { FLOQ_TRUST_PROXY: "1" }), "203.0.113.9");
  assert.equal(authSeesIp({ "x-forwarded-for": "1.2.3.4" }, "203.0.113.9", { FLOQ_TRUST_PROXY: "false" }), "203.0.113.9");
});

test("x-real-ip is dropped and never used", () => {
  const req = { headers: { "x-real-ip": "9.9.9.9" }, socket: { remoteAddress: "203.0.113.9" } } as never as Parameters<typeof clientIp>[0];
  normalizeAuthForwardedHeaders(req, {});
  assert.equal(req.headers["x-real-ip"], undefined);
});

test("with FLOQ_TRUST_PROXY=true the hop appended by the trusted proxy is used, not client-forged earlier hops", () => {
  const env = { FLOQ_TRUST_PROXY: "true" };
  assert.equal(authSeesIp({ "x-forwarded-for": "6.6.6.6, 198.51.100.7" }, "10.0.0.2", env), "198.51.100.7");
  assert.equal(authSeesIp({ "x-forwarded-for": "198.51.100.7" }, "10.0.0.2", env), "198.51.100.7");
  // No header from the proxy: fall back to the socket.
  assert.equal(authSeesIp({}, "10.0.0.2", env), "10.0.0.2");
});
