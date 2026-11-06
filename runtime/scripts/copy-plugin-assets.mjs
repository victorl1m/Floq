// tsc only emits code (and imported JSON). Plugin skill folders (`<plugin>/skills/**`, Markdown) are copied next to the compiled plugin.
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const src = "src/plugins";
const out = "dist/plugins";
if (existsSync(src)) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const skills = join(src, entry.name, "skills");
    if (entry.isDirectory() && existsSync(skills)) cpSync(skills, join(out, entry.name, "skills"), { recursive: true });
  }
}
