// Minimal MCP-style server over stdio (newline-delimited JSON-RPC), used to test the floq-vault wrapper.
// Every request is answered with the SHA-256 and byte length of the exact line received, plus the env it sees, so a test
// can prove frames arrive untouched. `ping` answers immediately with a tiny frame (to catch buffering delays).
const { createHash } = require("node:crypto");
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let index;
  while ((index = buffer.indexOf(10)) >= 0) {
    const line = buffer.subarray(0, index);
    buffer = buffer.subarray(index + 1);
    if (!line.length) continue;
    const message = JSON.parse(line.toString("utf8"));
    const result = {
      sha256: createHash("sha256").update(line).digest("hex"),
      bytes: line.length,
      testSecret: process.env.TEST_SECRET ?? null,
      other: process.env.OTHER_SECRET ?? null,
      floqToken: process.env.FLOQ_AGENT_TOKEN ?? null,
    };
    if (message.method === "stderr") process.stderr.write("server says " + process.env.TEST_SECRET + "\n");
    if (message.method === "big") result.echo = "x".repeat(message.params.size);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
});
process.stdin.on("end", () => process.exit(0));
