const BY_EXTENSION: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", md: "markdown", mdx: "mdx", css: "css", scss: "scss", html: "html", htm: "html", xml: "xml", svg: "xml",
  py: "python", rs: "rust", go: "go", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", sh: "bash", bash: "bash", zsh: "bash",
  ps1: "powershell", bat: "bat", cmd: "bat", sql: "sql", java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  rb: "ruby", php: "php", lua: "lua", diff: "diff", patch: "diff",
};
const BY_NAME: Record<string, string> = { dockerfile: "docker", makefile: "make", ".gitignore": "ini", ".env": "ini" };

/** Highlighter language id for a file path, or null when unknown (shown as plain text). */
export function languageForPath(path: string): string | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith(".env")) return "ini";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1)] ?? null : null;
}
