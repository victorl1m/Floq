import type { Config } from "./config.js";

const LEVELS: Record<Config["logLevel"], number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|authorization)/i;
const SECRET_QUERY = /([?&](?:token|access_token|api_key|key)=)[^&]*/gi;

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SECRET_QUERY, "$1[redacted]");
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return redactObject(value as Record<string, unknown>);
  return value;
}

function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactValue(value);
  }
  return out;
}

let threshold = LEVELS.info;

export function configureLogger(config: Config): void {
  threshold = LEVELS[config.logLevel] ?? LEVELS.info;
}

function emit(level: Exclude<Config["logLevel"], never>, event: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields ? (redactObject(fields) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
