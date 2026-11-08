import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { bearer } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import type pg from "pg";
import type { Config } from "./config.js";
import { log } from "./logger.js";
import type { SetupToken } from "./setupToken.js";
import { registerBootstrapAdmin } from "./bootstrapRegistration.js";

/** x-forwarded-for is the only header better-auth reads for the client IP (see the comment in createAuth). */
export const AUTH_IP_ADDRESS = { ipAddressHeaders: ["x-forwarded-for"] };

export function createAuth(config: Config, pool: pg.Pool) {
  return betterAuth({
    appName: "Floq",
    baseURL: config.authUrl,
    secret: config.authSecret,
    database: pool,
    trustedOrigins: config.allowedOrigins,
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.allowSignup,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 300, max: 5 },
        "/change-password": { window: 300, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: config.authUrl.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "none", secure: config.authUrl.startsWith("https://") },
      // better-auth rate-limits per IP read from x-forwarded-for. That header is client-controlled, so server.ts
      // (normalizeAuthForwardedHeaders in clientIp.ts) overwrites it with the trusted client address (socket peer, or the
      // proxy-appended hop under FLOQ_TRUST_PROXY=true) and deletes x-real-ip before every /api/auth/* request.
      ipAddress: AUTH_IP_ADDRESS,
    },
    // The bootstrap admin account is created only through /v1/setup/admin (direct insert, not this path): open signup
    // must never let someone else claim that email.
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (config.bootstrapAdminEmail && String(user.email ?? "").trim().toLowerCase() === config.bootstrapAdminEmail.toLowerCase()) {
              throw new APIError("FORBIDDEN", { message: "This email is reserved for setup" });
            }
          },
        },
      },
    },
    plugins: [bearer()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

export async function migrateAuth(auth: Auth): Promise<void> {
  const { runMigrations, toBeCreated, toBeAdded } = await getMigrations(auth.options);
  if (toBeCreated.length > 0 || toBeAdded.length > 0) {
    log.info("auth.migrate", { create: toBeCreated.length, add: toBeAdded.length });
    await runMigrations();
  }
}

/** True while the configured bootstrap admin email has no account yet. */
export async function setupAvailable(pool: pg.Pool, config: Config, email: string): Promise<boolean> {
  if (!config.bootstrapAdminEmail || email !== config.bootstrapAdminEmail) return false;
  const existing = await pool.query('SELECT 1 FROM "user" WHERE lower(email) = $1 LIMIT 1', [email]);
  return !existing.rowCount;
}

/** Setup is claimable only with the one-time setup token: without it the answer is the same as for any other email. */
export async function setupLookupStep(pool: pg.Pool, config: Config, setupToken: SetupToken, email: string, token: unknown): Promise<"setup" | "password"> {
  if (!(await setupAvailable(pool, config, email))) return "password";
  return (await setupToken.verify(token)) ? "setup" : "password";
}

/** Create the bootstrap admin with the password they chose and the one-time setup token. Returns false if unavailable or the token is wrong/used. */
export async function createBootstrapAdmin(
  auth: Auth,
  pool: pg.Pool,
  config: Config,
  email: string,
  password: string,
  name: string,
  companyName: string | undefined,
  setupToken: SetupToken,
  token: unknown,
): Promise<boolean> {
  if (!(await setupAvailable(pool, config, email))) return false;
  if (!(await setupToken.verify(token))) return false;
  const ctx = await auth.$context;
  const created = await registerBootstrapAdmin(pool, { email, password, name, companyName }, (value) => ctx.password.hash(value));
  if (!created) return false;
  await setupToken.markUsed();
  log.info("auth.bootstrap_admin", { email });
  return true;
}
