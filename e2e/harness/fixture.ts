import type { Memory, MemoryType } from "../../src/lib/runtime/types";

const TYPES: MemoryType[] = ["fact", "decision", "procedure", "episode"];
const TOPICS: Array<{ name: string; words: string[] }> = [
  { name: "Deploy", words: ["deploy", "production", "release", "pipeline", "rollback", "server", "build"] },
  { name: "Database", words: ["postgres", "migration", "schema", "backup", "index", "query", "replica"] },
  { name: "Frontend", words: ["react", "component", "tailwind", "canvas", "dialog", "theme", "render"] },
  { name: "Auth", words: ["token", "session", "login", "oauth", "password", "cookie", "refresh"] },
  { name: "Testing", words: ["playwright", "vitest", "fixture", "coverage", "flaky", "assert", "mock"] },
  { name: "Agents", words: ["agent", "subagent", "prompt", "memory", "context", "recruit", "wire"] },
  { name: "Billing", words: ["invoice", "stripe", "plan", "trial", "refund", "tax", "webhook"] },
  { name: "Docs", words: ["readme", "guide", "changelog", "tutorial", "example", "reference", "style"] },
];

/** Deterministic fixture: topic clusters, mixed types, every 11th pinned, every 9th forgotten, plus a supersedes chain m3 -> m4 -> m5. */
export function makeMemories(n: number): Memory[] {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const out: Memory[] = [];
  for (let i = 0; i < n; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const w = (k: number) => topic.words[(i * 3 + k) % topic.words.length];
    const title = `${topic.name}: ${w(0)} ${w(1)} note ${i}`;
    const text = `${w(0)} and ${w(1)} are handled together with ${w(2)}. Remember that ${w(3)} must follow the ${w(4)} rule for the ${topic.name.toLowerCase()} area (item ${i}).\n\nSecond paragraph about ${w(5)}.`;
    const forgotten = i % 9 === 8;
    const upd = new Date(now - i * 3_600_000 * 5).toISOString();
    out.push({
      id: `m${i}`, projectId: "p1", scope: i % 17 === 16 ? "user" : "project", type: TYPES[(i * 7 + (i >> 2)) % 4],
      title: i % 13 === 12 ? "" : title, text, pinned: i % 11 === 0, author: i % 5 === 0 ? null : `agent-${i % 4}`, authorSession: null,
      createdAt: upd, updatedAt: upd, invalidatedAt: forgotten ? upd : null, supersededBy: null, invalidReason: forgotten ? "Outdated" : null,
    });
  }
  if (n > 6) {
    out[3].supersededBy = "m4"; out[3].invalidatedAt = out[3].updatedAt; out[3].invalidReason = "Replaced";
    out[4].supersededBy = "m5"; out[4].invalidatedAt = out[4].updatedAt; out[4].invalidReason = "Replaced";
  }
  return out;
}
