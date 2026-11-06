// Minimal in-memory stand-in for the keychain tables, matching the SQL in src/keychains.ts by shape.
let counter = 0;
const uuid = () => "00000000-0000-4000-8000-" + String(++counter).padStart(12, "0");

export function fakeKeychainPool(options: { projects: Record<string, string>; sessions: { id: string; user_id: string; project_id: string | null }[] }) {
  const keychains = new Map<string, any>();
  const secrets: { keychain_id: string; name: string; value_enc: Buffer; created_by: string | null; last_used_at: Date | null; last_used_by: string | null; use_count: number }[] = [];
  const uses: { keychain_id: string; name: string; session_id: string }[] = [];
  const links: { keychain_id: string; session_id: string }[] = [];
  const row = (k: any) => ({
    ...k,
    project_name: "repo",
    secret_names: secrets.filter((s) => s.keychain_id === k.id).map((s) => s.name).sort(),
    secret_info: secrets.filter((s) => s.keychain_id === k.id).map((s) => ({ name: s.name, createdBy: s.created_by, lastUsedAt: s.last_used_at, lastUsedBy: s.last_used_by, uses: s.use_count })),
    linked: links.filter((l) => l.keychain_id === k.id).map((l) => l.session_id),
  });
  async function query(sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number } | undefined> {
    if (/SELECT 1 FROM floq_projects WHERE id = \$1 AND user_id = \$2/.test(sql)) { const ok = options.projects[params[0]] === params[1]; return { rows: ok ? [{}] : [], rowCount: ok ? 1 : 0 }; }
    if (/FROM keychains k LEFT JOIN floq_projects/.test(sql)) {
      let rows = [...keychains.values()];
      if (/k\.id = \$1 AND k\.user_id = \$2/.test(sql)) rows = rows.filter((k) => k.id === params[0] && k.user_id === params[1]);
      else if (/project_id IS NOT DISTINCT FROM/.test(sql)) rows = rows.filter((k) => k.user_id === params[0] && k.project_id === params[1]);
      else rows = rows.filter((k) => k.user_id === params[0]);
      return { rows: rows.map(row), rowCount: rows.length };
    }
    if (/SELECT count\(\*\)::int AS n FROM keychains/.test(sql)) return { rows: [{ n: [...keychains.values()].filter((k) => k.user_id === params[0] && k.project_id === params[1]).length }], rowCount: 1 };
    if (/INSERT INTO keychains /.test(sql)) {
      const [user_id, project_id, name, color, x, y, w, h] = params;
      const id = uuid();
      keychains.set(id, { id, user_id, project_id, name, color, x, y, w, h, created_at: new Date(), updated_at: new Date() });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (/SELECT id, project_id FROM agent_sessions WHERE id = \$1 AND user_id = \$2/.test(sql)) {
      const s = options.sessions.find((x) => x.id === params[0] && x.user_id === params[1]);
      return { rows: s ? [{ id: s.id, project_id: s.project_id }] : [], rowCount: s ? 1 : 0 };
    }
    if (/INSERT INTO keychain_links/.test(sql)) { if (!links.some((l) => l.keychain_id === params[0] && l.session_id === params[1])) links.push({ keychain_id: params[0], session_id: params[1] }); return { rows: [], rowCount: 1 }; }
    if (/INSERT INTO keychain_secrets/.test(sql)) {
      const [keychain_id, , name, value_enc, created_by] = params;
      const existing = secrets.find((s) => s.keychain_id === keychain_id && s.name === name);
      if (existing) existing.value_enc = value_enc; else secrets.push({ keychain_id, name, value_enc, created_by, last_used_at: null, last_used_by: null, use_count: 0 });
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT k\.id, k\.name AS keychain_name, s\.value_enc FROM keychain_links/.test(sql)) {
      const [user_id, session_id, name] = params;
      const rows = links.filter((l) => l.session_id === session_id).map((l) => keychains.get(l.keychain_id)).filter((k) => k && k.user_id === user_id)
        .sort((a, b) => b.created_at - a.created_at || (b.id > a.id ? 1 : -1))
        .flatMap((k) => secrets.filter((x) => x.keychain_id === k.id && x.name === name).map((x) => ({ id: k.id, keychain_name: k.name, value_enc: x.value_enc })));
      return { rows, rowCount: rows.length };
    }
    if (/SELECT k\.name AS keychain, s\.name FROM keychain_links/.test(sql)) {
      const [user_id, session_id] = params;
      const rows = links.filter((l) => l.session_id === session_id).map((l) => keychains.get(l.keychain_id)).filter((k) => k && k.user_id === user_id)
        .flatMap((k) => secrets.filter((x) => x.keychain_id === k.id).map((x) => ({ keychain: k.name, name: x.name })));
      return { rows, rowCount: rows.length };
    }
    if (/UPDATE keychain_secrets SET last_used_at/.test(sql)) {
      const [keychain_id, , name, session] = params;
      const x = secrets.find((y) => y.keychain_id === keychain_id && y.name === name);
      if (x) { x.last_used_at = new Date(); x.last_used_by = session; x.use_count += 1; }
      return { rows: [], rowCount: x ? 1 : 0 };
    }
    if (/INSERT INTO keychain_secret_uses/.test(sql)) { uses.push({ keychain_id: params[0], name: params[2], session_id: params[3] }); return { rows: [], rowCount: 1 }; }
    if (/UPDATE keychains SET updated_at/.test(sql)) return { rows: [], rowCount: 1 };
    return undefined;
  }
  return { query, keychains, secrets, links, uses };
}
