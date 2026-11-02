import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// node-pty is CommonJS with a native binding, so load it through require to
// avoid ESM named-export interop surprises.
const nodePty = require("node-pty") as typeof import("node-pty");

export type PtyProcess = import("node-pty").IPty;

export function spawnPty(
  file: string,
  args: string[],
  options: import("node-pty").IPtyForkOptions,
): PtyProcess {
  return nodePty.spawn(file, args, options);
}
