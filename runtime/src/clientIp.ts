import type { IncomingMessage } from "node:http";

/**
 * Client address for rate limits: the socket peer, unless FLOQ_TRUST_PROXY=true (a proxy we control appends to
 * X-Forwarded-For; the rightmost hop is the one it added, earlier hops are client-controlled).
 */
export function clientIp(req: Pick<IncomingMessage, "headers" | "socket">, env: NodeJS.ProcessEnv = process.env): string {
  if (env.FLOQ_TRUST_PROXY === "true") {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
    const hop = raw?.split(",").pop()?.trim();
    if (hop) return hop;
  }
  return req.socket.remoteAddress || "unknown";
}

/**
 * Called before every /api/auth/* request. better-auth reads the client IP (for its per-IP sign-in rate limit) from
 * x-forwarded-for, so replace whatever the client sent with the trusted address and drop x-real-ip.
 * Do not remove this: auth.ts relies on it.
 */
export function normalizeAuthForwardedHeaders(req: Pick<IncomingMessage, "headers" | "socket">, env: NodeJS.ProcessEnv = process.env): void {
  req.headers["x-forwarded-for"] = clientIp(req, env);
  delete req.headers["x-real-ip"];
}
