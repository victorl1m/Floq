import test from "node:test";
import assert from "node:assert/strict";
import { loadSkillFromCatalog, previewCatalogSkill, searchSkillCatalog } from "../dist/skillCatalog.js";

const manifest = "---\nname: vercel-react-best-practices\ndescription: React UI guidance\n---\n\nPrefer accessible components.\n";
function mockFetch(t, handler) {
  const prior = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = prior; });
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("catalog search validates limits and normalizes the public result shape", async (t) => {
  mockFetch(t, async (url, init) => {
    assert.equal(String(url), "https://skills.sh/api/search?q=react&limit=4");
    assert.equal(init.redirect, "error");
    return json({ skills: [
      { id: "vercel-labs/agent-skills/vercel-react-best-practices", source: "vercel-labs/agent-skills", skillId: "vercel-react-best-practices", name: "vercel-react-best-practices", installs: 42 },
      { id: "unsafe/../thing", source: "unsafe/../thing", slug: "..", name: "bad" },
    ] });
  });
  assert.deepEqual(await searchSkillCatalog(" react ", "4"), { skills: [{ id: "vercel-labs/agent-skills/vercel-react-best-practices", source: "vercel-labs/agent-skills", skillId: "vercel-react-best-practices", name: "vercel-react-best-practices", installs: 42 }] });
  await assert.rejects(searchSkillCatalog("x", undefined), /2-100/);
  await assert.rejects(searchSkillCatalog("react", "31"), /between 1 and 30/);
});

test("preview finds skills by manifest name and imports bounded package files from public GitHub", async (t) => {
  const urls = [];
  mockFetch(t, async (url) => {
    urls.push(String(url));
    if (urls.length === 1) return json({ default_branch: "main" });
    if (urls.length === 2) return json({ truncated: false, tree: [
      { path: "skills/react-best-practices/SKILL.md", type: "blob", size: manifest.length },
      { path: "skills/react-best-practices/references/example.md", type: "blob", size: 7 },
    ] });
    return new Response(String(url).endsWith("SKILL.md") ? manifest : "Example");
  });
  const result = await previewCatalogSkill({ source: "vercel-labs/agent-skills", skillId: "vercel-react-best-practices" });
  assert.equal(result.markdown, manifest);
  assert.deepEqual(result.files, [{ path: "SKILL.md", size: Buffer.byteLength(manifest) }, { path: "references/example.md", size: 7 }]);
  assert.equal(result.skill.installs, 0);
  assert.equal(urls[0], "https://api.github.com/repos/vercel-labs/agent-skills");
  assert.equal(urls[1], "https://api.github.com/repos/vercel-labs/agent-skills/git/trees/main?recursive=1");
});

test("GitHub SKILL.md URL imports are normalized to catalog identifiers; rejects arbitrary hosts and query data", async (t) => {
  mockFetch(t, async (url) => {
    if (String(url) === "https://api.github.com/repos/vercel-labs/agent-skills") return json({ default_branch: "main" });
    if (String(url) === "https://api.github.com/repos/vercel-labs/agent-skills/git/trees/main?recursive=1") return json({ truncated: false, tree: [{ path: "skills/react-best-practices/SKILL.md", type: "blob", size: manifest.length }] });
    assert.equal(String(url), "https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best-practices/SKILL.md");
    return new Response(manifest);
  });
  const loaded = await loadSkillFromCatalog({ url: "https://github.com/vercel-labs/agent-skills/tree/main/react-best-practices/SKILL.md" });
  assert.equal(loaded.skillId, "react-best-practices");
  await assert.rejects(loadSkillFromCatalog({ url: "https://example.com/owner/repo/SKILL.md" }), /Only skills.sh/);
  await assert.rejects(loadSkillFromCatalog({ url: "https://github.com/owner/repo/blob/main/react-ui/SKILL.md?token=secret" }), /clean HTTPS/);
});

test("raw.githubusercontent.com URLs fetch only a bounded manifest and never follow redirects", async (t) => {
  mockFetch(t, async (url, init) => {
    assert.equal(String(url), "https://raw.githubusercontent.com/owner/repo/main/react-ui/SKILL.md");
    assert.equal(init.redirect, "error");
    return new Response(manifest, { headers: { "content-type": "text/plain" } });
  });
  const loaded = await loadSkillFromCatalog({ url: "https://raw.githubusercontent.com/owner/repo/main/react-ui/SKILL.md" });
  assert.equal(loaded.source, "owner/repo");
  assert.equal(loaded.files[0].contents, manifest);
});

test("catalog package rejects path traversal and oversized content before installation", async (t) => {
  mockFetch(t, async (url) => {
    if (String(url) === "https://api.github.com/repos/owner/repo") return json({ default_branch: "main" });
    return json({ truncated: false, tree: [{ path: "../escape/SKILL.md", type: "blob", size: 10 }] });
  });
  await assert.rejects(loadSkillFromCatalog({ source: "owner/repo", skillId: "good" }), /Could not find the selected skill/);
  mockFetch(t, async (url) => {
    if (String(url) === "https://api.github.com/repos/owner/repo") return json({ default_branch: "main" });
    if (String(url).includes("/git/trees/")) return json({ truncated: false, tree: [{ path: "skills/good/SKILL.md", type: "blob", size: 33 * 1024 }] });
    return new Response("x".repeat(33 * 1024));
  });
  await assert.rejects(loadSkillFromCatalog({ source: "owner/repo", skillId: "good" }), /Could not find the selected skill/);
});
