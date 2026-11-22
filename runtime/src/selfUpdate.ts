/**
 * "Update runtime" inside Docker, with no platform API: the runtime talks to the Docker Engine through the socket that
 * docker-compose.yml mounts at DOCKER_SOCK (under /run, which agent sandboxes replace with a tmpfs, and owned by root, so
 * agents never reach it). The runtime starts a short-lived helper container from its own image; the helper clones the
 * release tag, rebuilds the runtime image under the same name, then recreates the runtime container with its exact
 * config (env, volumes, networks, labels). If the new container fails to start, the old one is put back.
 */
import { request } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

export const DOCKER_SOCK = "/run/floq-docker.sock";
const API = "/v1.44";

interface DockerRes { status: number; body: string }

export function dockerRequest(method: string, path: string, body?: unknown, opts: { tar?: NodeJS.ReadableStream; timeoutMs?: number } = {}): Promise<DockerRes> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.tar) headers["Content-Type"] = "application/x-tar";
    else if (body !== undefined) headers["Content-Type"] = "application/json";
    const req = request({ socketPath: DOCKER_SOCK, path: API + path, method, headers, timeout: opts.timeoutMs ?? 60_000 }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("timeout", () => req.destroy(new Error(`Docker ${method} ${path} timed out`)));
    req.on("error", reject);
    if (opts.tar) opts.tar.pipe(req);
    else req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export async function dockerOk(method: string, path: string, body?: unknown, opts?: { tar?: NodeJS.ReadableStream; timeoutMs?: number }): Promise<string> {
  const r = await dockerRequest(method, path, body, opts);
  if (r.status >= 300) throw new Error(`Docker ${method} ${path.split("?")[0]} answered ${r.status}: ${r.body.slice(0, 300)}`);
  return r.body;
}

const enc = encodeURIComponent;

export function dockerSelfUpdateAvailable(): boolean {
  return existsSync(DOCKER_SOCK);
}

interface Inspect {
  Id: string;
  Name: string;
  Image: string;
  Config: Record<string, unknown> & { Image: string; Hostname?: string };
  HostConfig: Record<string, unknown>;
  NetworkSettings: { Networks?: Record<string, { Aliases?: string[] | null; IPAMConfig?: unknown }> };
  Mounts?: { Source: string; Destination: string }[];
}

/** Started by the runtime: launch the helper and return; the helper stops this container when the new image is ready. */
export async function startDockerSelfUpdate(repo: string, tag: string): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^v?\d+\.\d+\.\d+$/.test(tag)) throw new Error("invalid release");
  const self = JSON.parse(await dockerOk("GET", `/containers/${enc(hostname())}/json`)) as Inspect;
  const sock = self.Mounts?.find((m) => m.Destination === DOCKER_SOCK)?.Source;
  if (!sock) throw new Error(`the Docker socket is not mounted at ${DOCKER_SOCK}`);
  const name = `floq-updater-${Date.now()}`;
  const created = JSON.parse(await dockerOk("POST", `/containers/create?name=${name}`, {
    Image: self.Image,
    Entrypoint: [process.execPath, fileURLToPath(import.meta.url)],
    Cmd: [self.Id, repo, tag, self.Config.Image],
    Labels: { "app.floq.updater": "1" },
    HostConfig: { AutoRemove: true, Binds: [`${sock}:${DOCKER_SOCK}`], NetworkMode: "bridge" },
  })) as { Id: string };
  await dockerOk("POST", `/containers/${created.Id}/start`);
  return `Updating to ${tag}: building the new image, then the runtime restarts by itself (a few minutes).`;
}

/** Highest x.y.z tag among recent releases (prereleases included; Floq publishes them as such). */
export async function latestReleaseTag(repo: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json", "User-Agent": "floq-runtime" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tags = ((await res.json()) as { tag_name?: string; draft?: boolean }[])
    .filter((r) => !r.draft && typeof r.tag_name === "string" && /^v?\d+\.\d+\.\d+$/.test(r.tag_name))
    .map((r) => r.tag_name!);
  const key = (t: string) => t.replace(/^v/, "").split(".").map(Number);
  tags.sort((a, b) => { const x = key(a), y = key(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; });
  return tags[0] ?? null;
}

async function build(src: string, image: string): Promise<void> {
  const tar = spawn("tar", ["-C", src, "-c", "."], { stdio: ["ignore", "pipe", "inherit"] });
  const out = await dockerOk("POST", `/build?t=${enc(image)}&rm=1&forcerm=1`, undefined, { tar: tar.stdout, timeoutMs: 60 * 60_000 });
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let msg: { error?: string; stream?: string };
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.error) throw new Error("image build failed: " + msg.error.slice(0, 500));
    if (msg.stream?.trim()) process.stdout.write(msg.stream);
  }
}

async function recreate(oldId: string, image: string): Promise<void> {
  const old = JSON.parse(await dockerOk("GET", `/containers/${oldId}/json`)) as Inspect;
  const name = old.Name.replace(/^\//, "");
  const nets = Object.entries(old.NetworkSettings.Networks ?? {});
  const endpoint = (aliases?: string[] | null) => ({ Aliases: (aliases ?? []).filter((a) => !old.Id.startsWith(a)) });
  const config = { ...old.Config, Image: image, HostConfig: old.HostConfig, NetworkingConfig: { EndpointsConfig: nets.length ? { [nets[0][0]]: endpoint(nets[0][1].Aliases) } : {} } };
  delete config.Hostname; // the new container gets its own id as hostname, so its self-inspect finds itself
  const parked = `${name}-floq-old-${Date.now()}`;
  await dockerOk("POST", `/containers/${oldId}/stop?t=30`, undefined, { timeoutMs: 90_000 });
  await dockerOk("POST", `/containers/${oldId}/rename?name=${enc(parked)}`);
  let newId: string | null = null;
  try {
    newId = (JSON.parse(await dockerOk("POST", `/containers/create?name=${enc(name)}`, config)) as { Id: string }).Id;
    for (const [net, ep] of nets.slice(1)) await dockerOk("POST", `/networks/${enc(net)}/connect`, { Container: newId, EndpointConfig: endpoint(ep.Aliases) });
    await dockerOk("POST", `/containers/${newId}/start`);
    await new Promise((r) => setTimeout(r, 15_000));
    const state = (JSON.parse(await dockerOk("GET", `/containers/${newId}/json`)) as { State: { Running: boolean } }).State;
    if (!state.Running) throw new Error("the new runtime container exited right after starting");
  } catch (error) {
    console.error("rolling back:", error instanceof Error ? error.message : error);
    if (newId) await dockerRequest("DELETE", `/containers/${newId}?force=1`).catch(() => {});
    await dockerOk("POST", `/containers/${oldId}/rename?name=${enc(name)}`);
    await dockerOk("POST", `/containers/${oldId}/start`);
    throw error;
  }
  await dockerRequest("DELETE", `/containers/${oldId}?force=1`).catch(() => {});
}

/** Helper entry: node selfUpdate.js <containerId> <owner/repo> <tag> <imageName> */
async function helperMain([oldId, repo, tag, image]: string[]): Promise<void> {
  if (!/^[0-9a-f]{12,64}$/.test(oldId) || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^v?\d+\.\d+\.\d+$/.test(tag) || !/^[\w./:@-]+$/.test(image)) throw new Error("bad arguments");
  const src = `/tmp/floq-src-${Date.now()}`;
  try {
    execFileSync("git", ["clone", "--depth", "1", "--branch", tag, `https://github.com/${repo}.git`, src], { stdio: "inherit", timeout: 10 * 60_000 });
    await build(`${src}/runtime`, image);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
  await recreate(oldId, image);
  console.log(`Floq runtime updated to ${tag}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  helperMain(process.argv.slice(2)).then(() => process.exit(0), (e) => { console.error("Floq self-update failed:", e instanceof Error ? e.message : e); process.exit(1); });
}
