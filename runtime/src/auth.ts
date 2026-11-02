import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { bearer } from "better-auth/plugins";
import type pg from "pg";
import type { Config } from "./config.js";
import { log } from "./logger.js";

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
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
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

/** Create the bootstrap admin with the password they chose. Returns false if the account already exists. */
export async function createBootstrapAdmin(
  auth: Auth,
  pool: pg.Pool,
  config: Config,
  email: string,
  password: string,
  name: string,
): Promise<boolean> {
  if (!(await setupAvailable(pool, config, email))) return false;
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(password);
  try {
    const user = await ctx.internalAdapter.createUser({ email, name, emailVerified: true }, {} as never);
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
  } catch (error) {
    if (!(await setupAvailable(pool, config, email))) return false; // lost a race: the account now exists
    throw error;
  }
  log.info("auth.bootstrap_admin", { email });
  return true;
}
