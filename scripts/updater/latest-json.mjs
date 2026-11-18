// Builds the Tauri updater feed (latest.json) and guards it against downgrades.
//
//   node scripts/updater/latest-json.mjs build --tag v1.2.3 --installer <exe> --repo owner/name
//        [--conf src-tauri/tauri.conf.json] [--notes docs/releases/v1.2.3.md] [--out latest.json]
//     Reads <exe>.sig (made by `tauri signer sign` over the FINAL, code-signed installer).
//   node scripts/updater/latest-json.mjs guard --new latest.json --existing existing.json
//     Exit 0 = publish the new feed, exit 10 = the published feed is newer: keep it.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(text) {
  const m = SEMVER.exec(String(text).replace(/^v/, ""));
  if (!m) throw new Error(`Not a semver version: ${text}`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

/** -1, 0 or 1. A pre-release sorts below its release. */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Keep the published feed when it is strictly newer than the build being published. */
export function shouldPublish(existingVersion, newVersion) {
  if (!existingVersion) return true;
  return compareVersions(newVersion, existingVersion) >= 0;
}

export function installerUrl(repo, tag, fileName) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Bad repo: ${repo}`);
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
}

export function buildLatestJson({ version, notes, pubDate, signature, url }) {
  parseVersion(version);
  if (!signature || !signature.trim()) throw new Error("Empty signature");
  if (!url.startsWith("https://github.com/")) throw new Error("The installer URL must be on github.com over HTTPS");
  return {
    version,
    notes: notes ?? "",
    pub_date: new Date(pubDate).toISOString(),
    platforms: { "windows-x86_64": { signature: signature.trim(), url } },
  };
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`Unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (cmd === "build") {
    const tag = a.tag, version = tag.replace(/^v/, "");
    const conf = JSON.parse(readFileSync(a.conf ?? "src-tauri/tauri.conf.json", "utf8"));
    if (conf.version !== version) throw new Error(`Tag ${tag} does not match tauri.conf.json version ${conf.version}`);
    const sigPath = `${a.installer}.sig`;
    if (!existsSync(sigPath)) throw new Error(`Missing ${sigPath}`);
    const notesPath = a.notes ?? `docs/releases/${tag}.md`;
    const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
    const feed = buildLatestJson({
      version, notes, pubDate: Date.now(), signature: readFileSync(sigPath, "utf8"),
      url: installerUrl(a.repo, tag, basename(a.installer)),
    });
    writeFileSync(a.out ?? "latest.json", `${JSON.stringify(feed, null, 2)}\n`);
    console.log(`latest.json for ${version} -> ${feed.platforms["windows-x86_64"].url}`);
  } else if (cmd === "guard") {
    const next = JSON.parse(readFileSync(a.new, "utf8")).version;
    let existing = null;
    if (a.existing && existsSync(a.existing)) {
      try { existing = JSON.parse(readFileSync(a.existing, "utf8")).version ?? null; } catch { existing = null; }
    }
    if (shouldPublish(existing, next)) { console.log(`Publishing ${next} (feed has ${existing ?? "nothing"})`); process.exit(0); }
    console.log(`Feed already has ${existing}, newer than ${next}: not replacing it`);
    process.exit(10);
  } else {
    console.error("usage: latest-json.mjs build|guard ...");
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
