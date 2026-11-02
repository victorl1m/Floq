import { badRequest, unavailable } from "./errors.js";
import { parseSkillMetadata } from "./skills.js";

const SEARCH_API = "https://skills.sh/api/search";
const GITHUB_API = "https://api.github.com/repos";
const MAX_QUERY = 100;
const MAX_RESULTS = 30;
const MAX_FILES = 120;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_SKILL_BYTES = 32 * 1024;
const MAX_TREE_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 30_000;
const MAX_MANIFEST_CANDIDATES = 80;
const SAFE_COMPONENT = /^[A-Za-z0-9._-]{1,128}$/;

export interface CatalogResult { id: string; source: string; skillId: string; name: string; installs: number }
export interface CatalogFile { path: string; contents: string }
export interface CatalogSkill { id: string; source: string; skillId: string; name: string; installs: number; files: CatalogFile[] }
const detailCache = new Map<string, { expiresAt: number; value: CatalogSkill }>();

function checkedSource(source: unknown): string {
  if (typeof source !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(source)) throw badRequest("source must be a GitHub owner/repository", "invalid_skill_source");
  return source;
}
function checkedSkillId(skillId: unknown): string {
  if (typeof skillId !== "string" || !SAFE_COMPONENT.test(skillId) || skillId === "." || skillId === "..") throw badRequest("skillId is invalid", "invalid_skill_id");
  return skillId;
}
function parseCatalogEntry(value: unknown): CatalogResult | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const source = typeof row.source === "string" ? row.source : "";
  const skillId = typeof row.skillId === "string" ? row.skillId : typeof row.slug === "string" ? row.slug : "";
  try {
    const safeSource = checkedSource(source);
    const safeId = checkedSkillId(skillId);
    const id = `${safeSource}/${safeId}`;
    if (row.id !== undefined && row.id !== id) return null;
    return { id, source: safeSource, skillId: safeId, name: typeof row.name === "string" ? row.name.slice(0, 120) : safeId, installs: Number.isSafeInteger(row.installs) && Number(row.installs) >= 0 ? Number(row.installs) : 0 };
  } catch { return null; }
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw unavailable("Skill catalog response exceeded the size limit", "skill_catalog_unavailable");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw unavailable("Skill package exceeded the size limit", "skill_package_unavailable"); }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return combined;
}

async function getJson(url: string, maxBytes = MAX_TOTAL_BYTES): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "Floq" }, redirect: "error" });
    if (!response.ok) throw unavailable("Skill catalog is temporarily unavailable", "skill_catalog_unavailable");
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(response, maxBytes));
    try { return JSON.parse(raw) as unknown; } catch { throw unavailable("Skill catalog returned invalid data", "skill_catalog_unavailable"); }
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    throw unavailable("Skill catalog request failed", "skill_catalog_unavailable");
  } finally { clearTimeout(timeout); }
}

export async function searchSkillCatalog(query: unknown, limitValue: unknown): Promise<{ skills: CatalogResult[] }> {
  if (typeof query !== "string" || query.trim().length < 2 || query.length > MAX_QUERY || /[\u0000-\u001f\u007f]/.test(query)) throw badRequest("q must contain 2-100 printable characters", "invalid_skill_query");
  const limit = limitValue === undefined || limitValue === null ? 20 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw badRequest("limit must be between 1 and 30", "invalid_skill_limit");
  const payload = await getJson(`${SEARCH_API}?q=${encodeURIComponent(query.trim())}&limit=${limit}`) as Record<string, unknown>;
  const entries = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.skills) ? payload.skills : [];
  return { skills: entries.slice(0, limit).map(parseCatalogEntry).filter((entry): entry is CatalogResult => entry !== null) };
}

async function detail(source: unknown, skillId: unknown): Promise<CatalogSkill> {
  const ownerRepo = checkedSource(source);
  const slug = checkedSkillId(skillId);
  const cacheKey = `${ownerRepo}/${slug}`;
  const cached = detailCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  detailCache.delete(cacheKey);
  const [owner, repo] = ownerRepo.split("/");
  const repoInfo = await getJson(`${GITHUB_API}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, 128 * 1024) as Record<string, unknown>;
  const branch = typeof repoInfo.default_branch === "string" ? repoInfo.default_branch : "";
  if (!branch || branch.length > 120 || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.split("/").some((part) => !part || part === "." || part === "..")) throw unavailable("GitHub repository default branch is unavailable", "skill_package_unavailable");
  const tree = await getJson(`${GITHUB_API}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`, MAX_TREE_BYTES) as Record<string, unknown>;
  if (tree.truncated === true || !Array.isArray(tree.tree) || tree.tree.length > MAX_TREE_ENTRIES) throw unavailable("GitHub repository skill index is too large", "skill_package_unavailable");
  const entries = (tree.tree as unknown[]).filter((item): item is { path: string; type: string; size?: number } => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    if (typeof row.path !== "string" || row.type !== "blob") return false;
    const path = row.path;
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !SAFE_COMPONENT.test(part) || part === "." || part === "..")) return false;
    return true;
  });
  const manifests = entries.filter((entry) => entry.path.toLowerCase().endsWith("/skill.md") || entry.path.toLowerCase() === "skill.md");
  const pathPart = (path: string) => path.split("/").at(-2) ?? "";
  const ordered = [...manifests].sort((a, b) => {
    const rank = (entry: typeof a) => {
      const directoryName = pathPart(entry.path).toLowerCase();
      return directoryName === slug.toLowerCase() ? 0 : slug.toLowerCase().endsWith(`-${directoryName}`) ? 1 : 2;
    };
    return rank(a) - rank(b) || a.path.localeCompare(b.path);
  }).slice(0, MAX_MANIFEST_CANDIDATES);
  const rawUrl = (path: string) => `https://raw.githubusercontent.com/${[owner, repo, ...branch.split("/"), ...path.split("/")].map(encodeURIComponent).join("/")}`;
  const fetchText = async (url: string, cap: number): Promise<string> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: "text/plain", "User-Agent": "Floq" }, redirect: "error" });
      if (!response.ok) throw unavailable("Skill package file is unavailable", "skill_package_unavailable");
      return new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(response, cap));
    } catch (error) {
      if (error && typeof error === "object" && "status" in error) throw error;
      throw unavailable("Skill package file could not be fetched", "skill_package_unavailable");
    } finally { clearTimeout(timeout); }
  };
  let matched: { path: string; contents: string; metadata: { name: string; description: string } } | null = null;
  for (const candidate of ordered) {
    if (candidate.size && candidate.size > MAX_SKILL_BYTES) continue;
    let contents: string;
    try { contents = await fetchText(rawUrl(candidate.path), MAX_SKILL_BYTES); } catch { continue; }
    const metadata = parseSkillMetadata(contents);
    if (!metadata) continue;
    const normalize = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (normalize(metadata.name) === slug.toLowerCase() || pathPart(candidate.path).toLowerCase() === slug.toLowerCase()) {
      matched = { path: candidate.path, contents, metadata };
      break;
    }
  }
  if (!matched) throw unavailable("Could not find the selected skill in its public GitHub repository", "skill_package_unavailable");
  const root = matched.path === "SKILL.md" ? "" : matched.path.slice(0, -"/SKILL.md".length);
  const packageEntries = entries.filter((entry) => entry.path === matched!.path || (root && entry.path.startsWith(root + "/")));
  const textExtensions = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".csv", ".svg"]);
  const selected = packageEntries.filter((entry) => {
    if (entry.path === matched!.path) return true;
    const extension = entry.path.slice(entry.path.lastIndexOf(".")).toLowerCase();
    return textExtensions.has(extension) && Number.isSafeInteger(entry.size) && Number(entry.size) <= MAX_FILE_BYTES;
  });
  if (selected.length > MAX_FILES) throw unavailable("Skill package contains too many text files", "skill_package_unavailable");
  let total = 0;
  const files: CatalogFile[] = [];
  for (const entry of selected) {
    const path = root ? entry.path.slice(root.length + 1) : entry.path;
    if (path.startsWith("/") || path.split("/").some((part) => !SAFE_COMPONENT.test(part) || part === "." || part === "..")) throw unavailable("Skill package contains an unsafe file path", "skill_package_unavailable");
    const contents = path === "SKILL.md" ? matched.contents : await fetchText(rawUrl(entry.path), MAX_FILE_BYTES);
    const size = Buffer.byteLength(contents, "utf8");
    if (size > MAX_FILE_BYTES) throw unavailable("Skill package contains a file over 64 KiB", "skill_package_unavailable");
    total += size;
    if (total > MAX_TOTAL_BYTES) throw unavailable("Skill package exceeded the size limit", "skill_package_unavailable");
    files.push({ path, contents });
  }
  const manifest = files.find((file) => file.path.toLowerCase() === "skill.md");
  if (!manifest || Buffer.byteLength(manifest.contents, "utf8") > MAX_SKILL_BYTES) throw unavailable("Skill package has no valid SKILL.md", "skill_package_unavailable");
  const result = { id: `${ownerRepo}/${slug}`, source: ownerRepo, skillId: slug, name: matched.metadata.name, installs: 0, files };
  if (detailCache.size >= 20) detailCache.delete(detailCache.keys().next().value!);
  detailCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, value: result });
  return result;
}

function parseAllowedUrl(raw: unknown): { source: string; skillId: string } {
  if (typeof raw !== "string" || raw.length > 2048) throw badRequest("url must be a skills.sh skill page or GitHub SKILL.md URL", "invalid_skill_url");
  let url: URL;
  try { url = new URL(raw); } catch { throw badRequest("url is invalid", "invalid_skill_url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw badRequest("Only clean HTTPS skills.sh and GitHub skill URLs are supported", "invalid_skill_url");
  let parts: string[];
  try { parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); }
  catch { throw badRequest("url path encoding is invalid", "invalid_skill_url"); }
  if (url.hostname === "skills.sh" && parts.length === 3 && parts.every((p) => SAFE_COMPONENT.test(p))) return { source: checkedSource(`${parts[0]}/${parts[1]}`), skillId: checkedSkillId(parts[2]) };
  if (url.hostname === "github.com" && parts.length >= 5 && SAFE_COMPONENT.test(parts[0]) && SAFE_COMPONENT.test(parts[1]) && parts[2] === "tree") {
    const source = checkedSource(`${parts[0]}/${parts[1]}`);
    const skillId = checkedSkillId(parts.at(-1)?.toLowerCase() === "skill.md" ? parts.at(-2) ?? "" : parts.at(-1) ?? "");
    return { source, skillId };
  }
  if (url.hostname === "github.com" && parts.length >= 6 && SAFE_COMPONENT.test(parts[0]) && SAFE_COMPONENT.test(parts[1]) && parts[2] === "blob" && parts.at(-1)?.toLowerCase() === "skill.md") {
    const source = checkedSource(`${parts[0]}/${parts[1]}`);
    return { source, skillId: checkedSkillId(parts.at(-2) ?? "") };
  }
  throw badRequest("Only skills.sh skill pages and GitHub URLs ending in SKILL.md are supported", "invalid_skill_url");
}

async function fetchRawGithub(url: URL): Promise<CatalogSkill> {
  const parts = url.pathname.split("/").filter(Boolean);
  let rawUrl: string;
  let source: string;
  let skillId: string;
  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 5 && parts.at(-1)?.toLowerCase() === "skill.md") {
    source = checkedSource(`${parts[0]}/${parts[1]}`);
    skillId = checkedSkillId(parts.at(-2) ?? "");
    rawUrl = url.href;
  } else if (url.hostname === "github.com" && parts.length >= 6 && parts[2] === "blob" && parts.at(-1)?.toLowerCase() === "skill.md") {
    source = checkedSource(`${parts[0]}/${parts[1]}`);
    skillId = checkedSkillId(parts.at(-2) ?? "");
    rawUrl = `https://raw.githubusercontent.com/${[parts[0], parts[1], ...parts.slice(3)].map(encodeURIComponent).join("/")}`;
  } else {
    throw badRequest("GitHub import URL must point directly to a SKILL.md file", "invalid_skill_url");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(rawUrl, { signal: controller.signal, headers: { Accept: "text/plain" }, redirect: "error" });
    if (!response.ok) throw unavailable("Skill URL could not be fetched", "skill_package_unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw unavailable("Skill URL returned an empty response", "skill_package_unavailable");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SKILL_BYTES) { await reader.cancel(); throw unavailable("SKILL.md exceeds 32 KiB", "skill_package_unavailable"); }
      chunks.push(value);
    }
    const contents = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    if (!/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(contents) || !/^name:\s*\S+/m.test(contents.slice(0, 8192))) throw unavailable("URL does not contain a valid SKILL.md", "skill_package_unavailable");
    return { id: `${source}/${skillId}`, source, skillId, name: skillId, installs: 0, files: [{ path: "SKILL.md", contents }] };
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    throw unavailable("Skill URL request failed", "skill_package_unavailable");
  } finally { clearTimeout(timeout); }
}

export async function loadSkillFromCatalog(input: { source?: unknown; skillId?: unknown; url?: unknown }): Promise<CatalogSkill> {
  if (input.url !== undefined) {
    if (input.source !== undefined || input.skillId !== undefined) throw badRequest("Provide either url or source and skillId", "invalid_skill_import");
    if (typeof input.url !== "string" || input.url.length > 2048) throw badRequest("url must be a skills.sh skill page or GitHub SKILL.md URL", "invalid_skill_url");
    let url: URL;
    try { url = new URL(input.url); } catch { throw badRequest("url is invalid", "invalid_skill_url"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw badRequest("Only clean HTTPS skills.sh and GitHub skill URLs are supported", "invalid_skill_url");
    if (url.hostname === "raw.githubusercontent.com" || (url.hostname === "github.com" && url.pathname.split("/").filter(Boolean)[2] === "blob")) return fetchRawGithub(url);
    const { source, skillId } = parseAllowedUrl(input.url);
    return detail(source, skillId);
  }
  return detail(input.source, input.skillId);
}

export async function previewCatalogSkill(input: { source?: unknown; skillId?: unknown; url?: unknown }): Promise<{ skill: Omit<CatalogSkill, "files"> & { files: never[] }; files: { path: string; size: number }[]; markdown: string }> {
  const skill = await loadSkillFromCatalog(input);
  const manifest = skill.files.find((file) => file.path.toLowerCase() === "skill.md")!;
  const { files: _files, ...metadata } = skill;
  return { skill: { ...metadata, files: [] }, files: skill.files.map(({ path, contents }) => ({ path, size: Buffer.byteLength(contents, "utf8") })), markdown: manifest.contents };
}
