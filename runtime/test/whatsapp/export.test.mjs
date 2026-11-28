// Export of chats: WhatsApp's export format (dates per locale, attachments, groups, deleted and edited), the zip with the media, files Floq does not have,
// keyset paging of a large chat, and the signed-download shape of the route.
import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import AdmZip from "adm-zip";
import { bundle, cleanup, closeAll, harness } from "./helpers.mjs";

let plugin, migrations, exp;
before(async () => {
  plugin = (await bundle("../../src/plugins/whatsapp/index.ts")).default;
  ({ migrations } = await bundle("../../src/plugins/whatsapp/migrations.ts"));
  exp = await bundle("../../src/plugins/whatsapp/export.ts");
});
after(cleanup);
afterEach(closeAll);

const A = "5511988887777@c.us", G = "120363041234567890@g.us", P1 = "5511911112222@c.us", P2 = "5511933334444@c.us";
const ME = { id: "5511900000001@c.us", name: "Shop" };
const at = (s) => "2026-11-25T" + s + "Z";

const msg = (h, m) => h.db.query(
  `INSERT INTO messages (user_id, session, chat_id, msg_id, stanza, from_me, sender, sender_name, body, has_media, sent_at, type, media, extra, edited_at, deleted_at, deleted_by, lost)
   VALUES ('u1','default',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
  [m.chat, m.id, m.id, m.me === true, m.from ?? "", m.name ?? "", m.body ?? "", Boolean(m.media), m.at, m.type ?? "chat", m.media ? JSON.stringify(m.media) : null, m.extra ? JSON.stringify(m.extra) : null,
    m.edited ?? null, m.deleted ?? null, m.by ?? "", m.lost === true]);
const blob = (h, id, mime, bytes) => h.db.query("INSERT INTO media_blobs (user_id, session, key, mime, bytes, size) VALUES ('u1','default',$1,$2,$3,$4)", ["m:" + id, mime, Buffer.from(bytes), bytes.length]);

/** The export a route returns, written to a sink; reads is called with the first chunk (to see how much had been read by then). */
async function download(h, query, onFirst) {
  const file = await h.get("/export", query);
  assert.equal(file.floqDownload, true);
  const chunks = [];
  let first = true;
  const sink = new Writable({ write(c, _e, cb) { if (first) { first = false; onFirst?.(); } chunks.push(c); cb(); } });
  await file.write(sink, new AbortController().signal);
  return { file, buf: Buffer.concat(chunks) };
}
const lines = (buf) => buf.toString("utf8").split("\n");
const seeded = async (opts = {}) => {
  const h = await harness(plugin, migrations, { settings: opts.settings });
  await h.db.query("INSERT INTO contacts (user_id, session, chat_id, name, push_name) VALUES ('u1','default',$1,'Ana Souza','Ana'), ('u1','default',$2,'Rafael',''), ('u1','default',$3,'','Bia')", [A, P1, P2]);
  await h.ctx.kv.set("u1", "s:default:me", ME).catch(() => undefined);
  return h;
};

test("dates follow the locale and the time zone; media names carry the time", () => {
  const d = new Date("2026-11-25T17:03:22Z");
  const br = exp.dateFormats("pt-BR", "America/Sao_Paulo");
  assert.equal(br.stamp(d), "25/11/2026, 14:03:22");
  assert.equal(br.file(d), "2026-11-25-14-03-22");
  assert.equal(exp.dateFormats("en-US", "UTC").stamp(d), "11/25/2026, 05:03:22 PM");
  assert.equal(exp.dateFormats("en-GB", "UTC").stamp(d), "25/11/2026, 17:03:22");
  assert.equal(exp.dateFormats("de-DE", "UTC").stamp(d), "25.11.2026, 17:03:22");
  // Nonsense falls back instead of failing.
  assert.equal(exp.dateFormats("xx-not a locale!", "Nowhere/Land").stamp(d), "25/11/2026, 17:03:22");
});

test("a 1:1 chat in WhatsApp's format: names, multi-line, edited, deleted, system, no media -> <Media omitted>, a plain .txt", async () => {
  const h = await seeded();
  await msg(h, { chat: A, id: "M1", from: A, body: "Oi, tudo bem?", at: at("14:03:22") });
  await msg(h, { chat: A, id: "M2", me: true, from: ME.id, body: "Tudo!\nE você?", at: at("14:04:00") });
  await msg(h, { chat: A, id: "M3", from: A, body: "fixed text", edited: at("14:06:00"), at: at("14:05:00") });
  await msg(h, { chat: A, id: "M4", from: A, body: "secret", deleted: at("14:07:00"), by: "sender", at: at("14:06:30") });
  await msg(h, { chat: A, id: "M5", from: A, body: "", type: "image", media: { mime: "image/jpeg", filename: "" }, at: at("14:08:00") });
  await msg(h, { chat: A, id: "M6", from: A, body: "Messages are end-to-end encrypted", type: "system", at: at("14:09:00") });
  await msg(h, { chat: A, id: "M7", from: A, body: "", type: "location", extra: { location: { lat: -23.5, lng: -46.6, name: "Office", address: "" } }, at: at("14:10:00") });
  const { file, buf } = await download(h, { chatId: A, name: "Ana Souza", locale: "pt-BR", tz: "UTC" });
  assert.equal(file.filename, "WhatsApp Chat - Ana Souza.txt");
  assert.match(file.contentType, /^text\/plain/);
  assert.deepEqual(lines(buf), [
    "[25/11/2026, 14:03:22] Ana Souza: Oi, tudo bem?",
    "[25/11/2026, 14:04:00] Shop: Tudo!", "E você?",
    "[25/11/2026, 14:05:00] Ana Souza: fixed text <edited>",
    "[25/11/2026, 14:06:30] Ana Souza: <This message was deleted>",
    "[25/11/2026, 14:08:00] Ana Souza: <Media omitted>",
    "[25/11/2026, 14:09:00] Messages are end-to-end encrypted",
    "[25/11/2026, 14:10:00] Ana Souza: location: https://maps.google.com/?q=-23.5,-46.6 (Office)", "",
  ]);
  // The original text of a deleted message never leaks without the option.
  assert.ok(!buf.toString().includes("secret"));
  // The same chat in the English (US) style.
  const us = (await download(h, { chatId: A, name: "Ana Souza", locale: "en-US", tz: "UTC" })).buf;
  assert.equal(lines(us)[0], "[11/25/2026, 02:03:22 PM] Ana Souza: Oi, tudo bem?");
});

test("a group: every message carries its sender's name (saved name, WhatsApp name, number); my own use my name", async () => {
  const h = await seeded();
  await msg(h, { chat: G, id: "G1", from: P1, body: "a", at: at("10:00:00") });
  await msg(h, { chat: G, id: "G2", from: P2, body: "b", at: at("10:01:00") });
  await msg(h, { chat: G, id: "G3", from: "5511955556666@c.us", name: "", body: "c", at: at("10:02:00") });
  await msg(h, { chat: G, id: "G4", from: "5511977778888@c.us", name: "Zé (push)", body: "d", at: at("10:03:00") });
  await msg(h, { chat: G, id: "G5", me: true, from: ME.id, body: "e", at: at("10:04:00") });
  const { buf } = await download(h, { chatId: G, name: "Equipe", locale: "en-GB", tz: "UTC" });
  const l = lines(buf);
  assert.deepEqual(l.slice(0, 5), ["[25/11/2026, 10:00:00] Rafael: a", "[25/11/2026, 10:01:00] Bia: b", "[25/11/2026, 10:02:00] +55 (11) 95555-6666: c", "[25/11/2026, 10:03:00] Zé (push): d", "[25/11/2026, 10:04:00] Shop: e"]);
});

test("with media: a zip with _chat.txt and the files Floq kept, named like WhatsApp does; what it lacks is listed as unavailable", async () => {
  const h = await seeded();
  await msg(h, { chat: A, id: "P1", from: A, body: "look", type: "image", media: { mime: "image/jpeg", filename: "" }, at: at("14:03:22") });
  await blob(h, "P1", "image/jpeg", "JPEGBYTES");
  await msg(h, { chat: A, id: "P2", from: A, body: "", type: "image", media: { mime: "image/png", filename: "" }, at: at("14:04:00") }); // never cached
  await msg(h, { chat: A, id: "D1", me: true, from: ME.id, body: "see attached", type: "document", media: { mime: "application/pdf", filename: "Report Q3.pdf" }, at: at("14:05:00") });
  await blob(h, "D1", "application/pdf", "%PDF-fake");
  await msg(h, { chat: A, id: "S1", from: A, body: "", type: "sticker", media: { mime: "image/webp", filename: "" }, at: at("14:06:00") });
  await blob(h, "S1", "image/webp", "WEBP");
  await msg(h, { chat: A, id: "V1", from: A, body: "", type: "ptt", media: { mime: "audio/ogg; codecs=opus", filename: "" }, at: at("14:07:00") });
  await blob(h, "V1", "audio/ogg", "OGG");
  const { file, buf } = await download(h, { chatId: A, name: "Ana Souza", media: "1", locale: "pt-BR", tz: "UTC" });
  assert.equal(file.filename, "WhatsApp Chat - Ana Souza.zip");
  assert.equal(file.contentType, "application/zip");
  const zip = new AdmZip(buf);
  const names = zip.getEntries().map((e) => e.entryName).sort();
  assert.deepEqual(names, ["00000001-PHOTO-2026-11-25-14-03-22.jpg", "00000003-Report Q3.pdf", "00000004-STICKER-2026-11-25-14-06-00.webp", "00000005-AUDIO-2026-11-25-14-07-00.opus", "_chat.txt"]);
  assert.equal(zip.readAsText("00000001-PHOTO-2026-11-25-14-03-22.jpg"), "JPEGBYTES");
  assert.equal(zip.readAsText("00000003-Report Q3.pdf"), "%PDF-fake");
  assert.deepEqual(zip.readAsText("_chat.txt").split("\n"), [
    "[25/11/2026, 14:03:22] Ana Souza: <attached: 00000001-PHOTO-2026-11-25-14-03-22.jpg>", "look",
    "[25/11/2026, 14:04:00] Ana Souza: <attached: 00000002-PHOTO-2026-11-25-14-04-00.png> (file not available)",
    "[25/11/2026, 14:05:00] Shop: <attached: 00000003-Report Q3.pdf>", "see attached",
    "[25/11/2026, 14:06:00] Ana Souza: <attached: 00000004-STICKER-2026-11-25-14-06-00.webp>",
    "[25/11/2026, 14:07:00] Ana Souza: <attached: 00000005-AUDIO-2026-11-25-14-07-00.opus>", "",
  ]);
  // Nothing was asked of WhatsApp.
  assert.equal(h.requests.filter((r) => r.path.startsWith("/api/files") || r.path.includes("/messages/")).length, 0);
});

test("deleted messages: the original only with the option, only when Floq kept it (lost rows stay deleted), its file only if cached, never fetched", async () => {
  const h = await seeded();
  await msg(h, { chat: A, id: "X1", from: A, body: "the secret plan", deleted: at("15:00:10"), by: "sender", at: at("15:00:00") });
  await msg(h, { chat: A, id: "X2", from: A, body: "pic caption", type: "image", media: { mime: "image/jpeg", filename: "" }, deleted: at("15:01:10"), by: "me", at: at("15:01:00") });
  await blob(h, "X2", "image/jpeg", "KEPT");
  await msg(h, { chat: A, id: "X3", from: A, body: "", type: "image", media: { mime: "image/jpeg", filename: "" }, deleted: at("15:02:10"), by: "sender", at: at("15:02:00") }); // file not kept
  await msg(h, { chat: A, id: "X4", from: A, body: "", deleted: at("15:03:00"), by: "", lost: true, at: at("15:03:00") }); // Floq never had it
  await msg(h, { chat: A, id: "X5", from: A, body: "was edited then deleted", edited: at("15:04:05"), deleted: at("15:04:10"), by: "sender", at: at("15:04:00") });
  const q = { chatId: A, name: "Ana", locale: "en-GB", tz: "UTC" };
  const plain = lines((await download(h, q)).buf);
  assert.deepEqual(plain.slice(0, 5), ["15:00:00", "15:01:00", "15:02:00", "15:03:00", "15:04:00"].map((t) => `[25/11/2026, ${t}] Ana: <This message was deleted>`));
  const withOrig = await download(h, { ...q, originals: "1", media: "1" });
  const zip = new AdmZip(withOrig.buf);
  assert.equal(zip.readAsText("_chat.txt"), [
    "[25/11/2026, 15:00:00] Ana: <This message was deleted> (original: the secret plan)",
    "[25/11/2026, 15:01:00] Ana: <This message was deleted> (original: <attached: 00000001-PHOTO-2026-11-25-15-01-00.jpg>\npic caption)",
    "[25/11/2026, 15:02:00] Ana: <This message was deleted> (original: <attached: 00000002-PHOTO-2026-11-25-15-02-00.jpg> (file not available))",
    "[25/11/2026, 15:03:00] Ana: <This message was deleted>",
    "[25/11/2026, 15:04:00] Ana: <This message was deleted> (original: was edited then deleted <edited>)", "",
  ].join("\n"));
  assert.equal(zip.readAsText("00000001-PHOTO-2026-11-25-15-01-00.jpg"), "KEPT");
  assert.equal(zip.getEntries().length, 2);
  assert.equal(h.requests.filter((r) => r.path.startsWith("/api/files") || r.path.includes("/messages/")).length, 0);
});

test("a transcript: HTML or Markdown next to the text, links to the files, escaped, deleted marked", async () => {
  const h = await seeded();
  await msg(h, { chat: A, id: "T1", from: A, body: "<b>hi</b> & *bye*", at: at("08:00:00") });
  await msg(h, { chat: A, id: "T2", me: true, from: ME.id, body: "", type: "image", media: { mime: "image/jpeg", filename: "" }, at: at("08:01:00") });
  await blob(h, "T2", "image/jpeg", "J");
  await msg(h, { chat: A, id: "T3", from: A, body: "gone", deleted: at("08:03:00"), by: "sender", at: at("08:02:00") });
  const q = { chatId: A, name: "Ana", locale: "en-GB", tz: "UTC", media: "1" };
  const html = new AdmZip((await download(h, { ...q, transcript: "html" })).buf);
  assert.deepEqual(html.getEntries().map((e) => e.entryName).sort(), ["00000001-PHOTO-2026-11-25-08-01-00.jpg", "_chat.txt", "chat.html"]);
  const page = html.readAsText("chat.html");
  assert.match(page, /&lt;b&gt;hi&lt;\/b&gt; &amp; \*bye\*/);
  assert.match(page, /<img src="00000001-PHOTO-2026-11-25-08-01-00.jpg"/);
  assert.match(page, /This message was deleted/); assert.ok(!page.includes("gone"));
  const md = new AdmZip((await download(h, { ...q, transcript: "md", media: "" })).buf);
  assert.deepEqual(md.getEntries().map((e) => e.entryName).sort(), ["_chat.txt", "chat.md"]);
  const text = md.readAsText("chat.md");
  assert.match(text, /^# Ana/); assert.match(text, /\*\*Ana\*\* · 25\/11\/2026, 08:00:00/); assert.match(text, /\\<b\\>hi/); assert.match(text, /_Media omitted_/);
});

test("export all chats: one folder per chat (names made unique), each with its own text and files", async () => {
  const h = await seeded();
  await msg(h, { chat: A, id: "A1", from: A, body: "to ana", at: at("09:00:00") });
  await msg(h, { chat: P1, id: "R1", from: P1, body: "to rafael", type: "image", media: { mime: "image/jpeg", filename: "" }, at: at("09:01:00") });
  await blob(h, "R1", "image/jpeg", "RJ");
  await msg(h, { chat: G, id: "GG1", from: P2, body: "to group", at: at("09:02:00") });
  await h.db.query("INSERT INTO contacts (user_id, session, chat_id, name) VALUES ('u1','default',$1,'Ana Souza')", [G]); // same name as Ana's chat
  const { file, buf } = await download(h, { all: "1", media: "1", locale: "en-GB", tz: "UTC" });
  assert.match(file.filename, /^WhatsApp Chats - Shop\.zip$/);
  const zip = new AdmZip(buf);
  const names = zip.getEntries().map((e) => e.entryName).sort();
  assert.deepEqual(names, ["Ana Souza (2)/_chat.txt", "Ana Souza/_chat.txt", "Rafael/00000001-PHOTO-2026-11-25-09-01-00.jpg", "Rafael/_chat.txt"].sort());
  const texts = Object.fromEntries(names.filter((n) => n.endsWith(".txt")).map((n) => [n, zip.readAsText(n)]));
  assert.ok(Object.values(texts).some((t) => t.includes("to group")) && Object.values(texts).some((t) => t.includes("to ana")));
  assert.match(texts["Rafael/_chat.txt"], /Rafael: <attached: 00000001-PHOTO-2026-11-25-09-01-00.jpg>/);
});

test("a large chat is read page by page and streamed: the first bytes leave before the last page is read; every message once, in order", async () => {
  const h = await seeded();
  const N = exp.EXPORT_PAGE * 2 + 137;
  // Many rows at the very same second: the (time, id) cursor must neither skip nor repeat any.
  await h.db.query(
    `INSERT INTO messages (user_id, session, chat_id, msg_id, stanza, from_me, sender, body, sent_at)
     SELECT 'u1','default',$1,'L'||g,'L'||g,FALSE,$1,'message '||g, timestamptz '2026-11-25 12:00:00+00' + ((g/3) || ' seconds')::interval FROM generate_series(1,$2) g`, [A, N]);
  let pages = 0, atFirst = 0;
  const real = h.ctx.db.query;
  h.ctx.db.query = async (sql, params) => { if (sql.includes("ORDER BY m.sent_at ASC")) pages++; return real(sql, params); };
  const { buf } = await download(h, { chatId: A, name: "Ana", locale: "en-GB", tz: "UTC" }, () => { atFirst = pages; });
  h.ctx.db.query = real;
  const l = lines(buf).filter(Boolean);
  assert.equal(l.length, N);
  assert.equal(pages, Math.ceil((N + 1) / exp.EXPORT_PAGE) || 1);
  assert.ok(atFirst < pages, "the first chunk was written before the last page was read");
  const seen = l.map((x) => Number(/message (\d+)$/.exec(x)[1]));
  assert.deepEqual(seen, Array.from({ length: N }, (_, i) => i + 1));
});

test("a stopped download stops reading; a route without a chat is refused; only the owner can export", async () => {
  const h = await seeded();
  await msg(h, { chat: A, id: "Z1", from: A, body: "x", at: at("09:00:00") });
  await assert.rejects(() => h.get("/export", {}), (e) => e.status === 400);
  await assert.rejects(() => h.routes["GET /export"]({ userId: "intruder", query: { chatId: A }, params: {}, body: undefined }), (e) => e.status === 403);
  const file = await h.get("/export", { chatId: A, name: "Ana" });
  const ac = new AbortController(); ac.abort();
  await assert.rejects(() => file.write(new Writable({ write(_c, _e, cb) { cb(); } }), ac.signal));
});
