// Deleted ("delete for everyone"), edited messages and stickers: parsing per engine, storage (out of order, history, groups, my own deletes),
// what is kept for recovery, the chat list, unread counts and the island card.
import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bundle, cleanup, closeAll, harness } from "./helpers.mjs";

let plugin, migrations, parse;
before(async () => {
  plugin = (await bundle("../../src/plugins/whatsapp/index.ts")).default;
  ({ migrations } = await bundle("../../src/plugins/whatsapp/migrations.ts"));
  parse = await bundle("../../src/plugins/whatsapp/parse.ts");
});
after(cleanup);
afterEach(closeAll);

const A = "5511988887777@c.us", G = "120363041234567890@g.us", P1 = "5511911112222@c.us", P2 = "5511933334444@c.us";
const ME = { id: "5511900000001@c.us", pushName: "Shop" };
const T = 1700000000;
const P = (p) => parse.parseMessage({ timestamp: T, from: A, fromMe: false, body: "", hasMedia: false, ...p }, "default");
/** A NOWEB protocol message (the revoke / edit itself) of chat `chat`, sent by `by` ("me" or a participant). */
const proto = (chat, id, by, protocolMessage, extra = {}) => ({
  id: `${by === "me"}_${chat}_${id}`, timestamp: T + 500, fromMe: by === "me", ...(by === "me" ? { to: chat, from: ME.id } : { from: chat }), ...(chat.endsWith("@g.us") && by !== "me" ? { participant: by } : {}),
  body: "", hasMedia: false, _data: { key: { id }, message: { protocolMessage } }, ...extra,
});
const revoke = (chat, id, target, by, key = {}) => proto(chat, id, by, { key: { id: target, remoteJid: chat, fromMe: by === "me", ...key } });
const editOf = (chat, id, target, by, text, ms = (T + 600) * 1000) => proto(chat, id, by, { key: { id: target, remoteJid: chat, fromMe: by === "me" }, type: 14, editedMessage: { conversation: text }, timestampMs: String(ms) });

// ---- parsing ----

test("protocol messages: NOWEB revoke (type left out) and edit, GOWS revoke and edit, WEBJS revoked and edited flags", () => {
  const r = parse.parseMessage(revoke(A, "RV1", "ORIG", A), "default");
  assert.equal(r.protocol.kind, "revoke"); assert.equal(r.protocol.target, "ORIG"); assert.equal(r.protocol.targetFromMe, false);
  const e = parse.parseMessage(editOf(A, "ED1", "ORIG", A, "fixed"), "default");
  assert.deepEqual([e.protocol.kind, e.protocol.target, e.protocol.body, e.protocol.at.getTime()], ["edit", "ORIG", "fixed", (T + 600) * 1000]);
  // NOWEB wraps the edit in editedMessage; a caption edit carries the media node.
  const wrapped = P({ id: "false_" + A + "_ED2", _data: { message: { editedMessage: { message: { protocolMessage: { key: { id: "IMG" }, type: "MESSAGE_EDIT", editedMessage: { imageMessage: { caption: "new caption" } } } } } } } });
  assert.deepEqual([wrapped.protocol.kind, wrapped.protocol.target, wrapped.protocol.body], ["edit", "IMG", "new caption"]);
  const ext = P({ id: "false_" + A + "_ED3", _data: { message: { protocolMessage: { key: { id: "X" }, type: 14, editedMessage: { extendedTextMessage: { text: "long *edit*" } } } } } });
  assert.equal(ext.protocol.body, "long *edit*");
  // GOWS: PascalCase keys, Info.Edit says what it is.
  const gr = P({ id: "false_" + G + "_GR", from: G, participant: P2, _data: { Info: { Edit: "8", Sender: P2 }, Message: { protocolMessage: { Key: { ID: "GORIG", Participant: "5511911112222@s.whatsapp.net", FromMe: false }, Type: "REVOKE" } } } });
  assert.deepEqual([gr.protocol.kind, gr.protocol.target, gr.protocol.targetSender], ["revoke", "GORIG", P1]);
  const ge = P({ id: "false_" + A + "_GE", _data: { Info: { Edit: "1" }, Message: { editedMessage: { message: { protocolMessage: { key: { ID: "GO2" }, editedMessage: { conversation: "gows edit" } } } } } } });
  assert.deepEqual([ge.protocol.kind, ge.protocol.target, ge.protocol.body], ["edit", "GO2", "gows edit"]);
  // Other protocol messages (disappearing setting, history sync) are nothing to show.
  assert.equal(P({ id: "false_" + A + "_O", _data: { message: { protocolMessage: { type: 3, ephemeralExpiration: 86400 } } } }).protocol.kind, "other");
  // WEBJS: a revoked message in the history; an edited one says so.
  const wr = P({ id: "false_" + A + "_W1", _data: { type: "revoked" } });
  assert.equal(wr.revoked, true); assert.equal(wr.protocol, undefined);
  const we = P({ id: "false_" + A + "_W2", body: "now", _data: { type: "chat", latestEditMsgKey: { id: "x" }, latestEditSenderTimestampMs: (T + 60) * 1000 } });
  assert.equal(we.editedAt.getTime(), (T + 60) * 1000); assert.equal(we.revoked, undefined);
  // NOWEB history: a revoke stub has no message left.
  assert.equal(P({ id: "false_" + A + "_N1", _data: { key: { id: "N1" }, messageStubType: 1 } }).revoked, true);
  // An ordinary message is none of these.
  const plain = P({ id: "false_" + A + "_PL", body: "hi", _data: { message: { conversation: "hi" } } });
  assert.equal(plain.protocol, undefined); assert.equal(plain.revoked, undefined); assert.equal(plain.editedAt, undefined);
});

test("stickers: static and animated webp, lottie (wrapped, application/was), WEBJS and GOWS, a webp with no type", () => {
  const st = P({ id: "false_" + A + "_S1", hasMedia: true, media: { url: "http://x/api/files/s.webp", mimetype: "image/webp" }, _data: { message: { stickerMessage: { mimetype: "image/webp", width: 512, height: 512, fileLength: "20000" } } } });
  assert.equal(st.type, "sticker"); assert.deepEqual(st.media, { mime: "image/webp", filename: "", url: "http://x/api/files/s.webp", size: 20000, width: 512, height: 512 });
  const an = P({ id: "false_" + A + "_S2", hasMedia: true, media: { url: "http://x/a.webp", mimetype: "image/webp" }, _data: { message: { stickerMessage: { mimetype: "image/webp", isAnimated: true } } } });
  assert.equal(an.media.animated, true); assert.equal(an.media.lottie, undefined);
  const lo = P({ id: "false_" + A + "_S3", hasMedia: true, media: { url: null, mimetype: null }, _data: { message: { lottieStickerMessage: { message: { stickerMessage: { mimetype: "application/was", isAnimated: true, isLottie: true, width: 512, height: 512 } } } } } });
  assert.deepEqual([lo.type, lo.media.mime, lo.media.animated, lo.media.lottie, lo.media.width], ["sticker", "application/was", true, true, 512]);
  const wj = P({ id: "false_" + A + "_S4", hasMedia: true, media: { mimetype: "image/webp", url: "http://x/w.webp" }, _data: { type: "sticker", isAnimated: true } });
  assert.deepEqual([wj.type, wj.media.animated], ["sticker", true]);
  const gw = P({ id: "false_" + A + "_S5", hasMedia: true, media: { mimetype: "image/webp" }, _data: { Info: { MediaType: "sticker" }, Message: { StickerMessage: { Mimetype: "image/webp", IsAnimated: false } } } });
  assert.equal(gw.type, "sticker"); assert.equal(gw.media.animated, undefined);
  assert.equal(P({ id: "false_" + A + "_S6", hasMedia: true, media: { mimetype: "image/webp", url: "http://x/u.webp" } }).type, "sticker");
});

// ---- deletes ----

const WEBP = Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 fake");
const files = (hits) => (method, path) => { if (path.startsWith("/api/files/")) { hits.push(path); return { bytes: path.endsWith(".webp") ? WEBP : Buffer.from("JPEGDATA"), headers: { "content-type": path.endsWith(".webp") ? "image/webp" : "image/jpeg" } }; } return undefined; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("their delete for everyone: the bubble turns deleted in place, the original (text, quote, cached file) is kept and can be revealed, nothing is sent to WhatsApp", async () => {
  const hits = [];
  const h = await harness(plugin, migrations, { waha: files(hits) });
  await h.message({ id: "false_" + A + "_Q1", from: A, body: "the question" });
  await h.message({ id: "false_" + A + "_D1", from: A, body: "look at this", hasMedia: true, media: { url: "http://localhost:3000/api/files/p.jpg", mimetype: "image/jpeg" }, _data: { type: "image", width: 800, height: 600, quotedStanzaID: "Q1", quotedMsg: { body: "the question", type: "chat" }, quotedParticipant: A } });
  await sleep(30); // the file is cached as it arrives
  const before = await h.chats();
  assert.equal(before[0].unread, 2);
  const n0 = h.requests.length;
  await h.event("message.any", revoke(A, "RV1", "D1", A));
  await h.event("message.revoked", { after: revoke(A, "RV1", "D1", A), before: null, revokedMessageId: "D1" });
  // Nothing went to WhatsApp for it.
  // (Contact details may be looked up for the sender, as for any event: nothing else.)
  assert.deepEqual(h.requests.slice(n0).filter((r) => r.method !== "GET" || !r.path.startsWith("/api/contacts")), []);
  const log = await h.messages(A);
  assert.equal(log.length, 2, "the revoke is not a message of its own");
  const d = log[1];
  assert.deepEqual([d.deleted, d.type, d.body, d.media, d.deletedBy], [true, "deleted", "", null, "sender"]);
  assert.equal(d.deletedAt, new Date((T + 500) * 1000).toISOString());
  assert.equal(d.original.body, "look at this"); assert.equal(d.original.type, "image");
  assert.deepEqual([d.original.media.mime, d.original.media.width, d.original.media.available], ["image/jpeg", 800, true]);
  assert.equal(d.replyTo.body, "the question");
  // The cached file stays viewable from the reveal.
  const f = await h.get("/media", { id: d.id });
  assert.equal(Buffer.from(f.data, "base64").toString(), "JPEGDATA");
  // Chat list: deleted preview, unread unchanged (the revoke is not one more message), total unchanged.
  const c = (await h.chats())[0];
  assert.deepEqual([c.lastDeleted, c.lastBody, c.unread, c.total], [true, "", 2, 2]);
  // The deleted message is not found by search.
  assert.equal((await h.messages(A, { q: "look" })).length, 0);
  // One "deleted" update reached the UI, not two.
  assert.equal(h.events.filter((e) => e.name === "message" && e.deleted).length, 1);
});

test("a deleted message whose file was never cached: the reveal says so and WAHA is not asked for it", async () => {
  const h = await harness(plugin, migrations, { waha: () => undefined });
  await h.message({ id: "false_" + A + "_D2", from: A, body: "", hasMedia: true, media: { url: null, mimetype: "image/jpeg" }, _data: { type: "image" } });
  await h.event("message.any", revoke(A, "RV2", "D2", A));
  const d = (await h.messages(A))[0];
  assert.equal(d.original.media.available, false);
  const n0 = h.requests.length;
  await assert.rejects(h.get("/media", { id: d.id }), (e) => e.status === 404 && e.code === "media_not_kept");
  assert.deepEqual(h.requests.slice(n0), []);
});

test("deleted before it arrived: a row says so (no original); the content filling in later (history) is kept as the original", async () => {
  const h = await harness(plugin, migrations, {});
  await h.event("message.any", revoke(A, "RV3", "LATE", A));
  let log = await h.messages(A);
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].deleted, log[0].original, log[0].fromMe], [true, null, false]);
  const c = (await h.chats())[0];
  assert.deepEqual([c.lastDeleted, c.total], [true, 1]);
  // The message itself shows up afterwards (an out-of-order webhook, or the import): it fills the row, it stays deleted.
  await h.message({ id: "false_" + A + "_LATE", from: A, body: "secret", timestamp: T + 10 });
  log = await h.messages(A);
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].deleted, log[0].original.body, log[0].sentAt], [true, "secret", new Date((T + 10) * 1000).toISOString()]);
  // No island card for a message that arrives already deleted.
  assert.equal(h.toasts.length, 0);
});

test("my own deletes: from the phone (fromMe revoke) and from Floq (delete for everyone) both keep the original and say 'me'", async () => {
  const h = await harness(plugin, migrations, { waha: () => ({ json: {} }) });
  await h.message({ id: "true_" + A + "_M1", to: A, from: ME.id, fromMe: true, body: "oops" }, { me: ME });
  await h.message({ id: "true_" + A + "_M2", to: A, from: ME.id, fromMe: true, body: "also oops" }, { me: ME });
  await h.event("message.any", revoke(A, "RV4", "M1", "me"), { me: ME });
  await h.post("/delete", { messageId: "true_" + A + "_M2", forEveryone: true });
  const log = await h.messages(A);
  assert.deepEqual(log.map((m) => [m.deleted, m.deletedBy, m.original.body]), [[true, "me", "oops"], [true, "me", "also oops"]]);
  assert.ok(log[1].deletedAt);
  const c = (await h.chats())[0];
  assert.deepEqual([c.lastDeleted, c.lastFromMe], [true, true]);
  // A late echo of my revoke does not change who deleted it.
  await h.event("message.revoked", { after: revoke(A, "RV5", "M2", "me"), revokedMessageId: "M2" }, { me: ME });
  assert.equal((await h.messages(A))[1].deletedBy, "me");
});

test("groups: the sender deleting is 'sender', an admin deleting someone else's message is 'admin' with the admin's name; delete-for-me keeps nothing", async () => {
  const h = await harness(plugin, migrations, { waha: () => ({ json: {} }) });
  await h.message({ id: "false_" + G + "_G1_" + P1, from: G, participant: P1, body: "from one", _data: { notifyName: "Rafa" } });
  await h.message({ id: "false_" + G + "_G2_" + P1, from: G, participant: P1, body: "spam", _data: { notifyName: "Rafa" } });
  await h.message({ id: "false_" + G + "_G3_" + P2, from: G, participant: P2, body: "admin talk", _data: { notifyName: "Bia" } });
  await h.event("message.any", revoke(G, "GR1", "G1", P1, { participant: P1 }));
  await h.event("message.any", revoke(G, "GR2", "G2", P2, { participant: P1 }));
  const log = await h.messages(G);
  assert.deepEqual(log.slice(0, 2).map((m) => [m.deleted, m.deletedBy, m.original.body]), [[true, "sender", "from one"], [true, "admin", "spam"]]);
  assert.equal(log[1].deletedByName, "Bia");
  // An admin deleting a message whose original Floq never had: still an admin delete.
  await h.event("message.any", revoke(G, "GR3", "GX", P2, { participant: P1 }));
  const lost = (await h.messages(G)).find((m) => m.id.includes("_GX"));
  assert.deepEqual([lost.deleted, lost.deletedBy, lost.original, lost.sender], [true, "admin", null, P1]);
  await h.post("/delete", { messageId: log[2].id, forEveryone: false });
  assert.equal((await h.messages(G)).some((m) => m.id === log[2].id), false);
});

test("the island card of a message that gets deleted goes away; an older message being deleted leaves the newer card", async () => {
  const h = await harness(plugin, migrations, { notify: true });
  await h.message({ id: "false_" + A + "_I1", from: A, body: "first" });
  await h.message({ id: "false_" + A + "_I2", from: A, body: "second" });
  assert.equal(h.notes.length, 2);
  await h.event("message.any", revoke(A, "RVI1", "I1", A));
  assert.equal(h.cleared.length, 0);
  await h.event("message.any", revoke(A, "RVI2", "I2", A));
  assert.deepEqual(h.cleared, ["default:" + A]);
});

// ---- edits ----

test("edits: text in place, 'edited', every version kept with its time; the webhook and the protocol message are one version; the chat list shows the latest", async () => {
  const h = await harness(plugin, migrations, { waha: () => undefined });
  await h.message({ id: "false_" + A + "_E1", from: A, body: "helo wrld" });
  await h.event("message.any", editOf(A, "ED1", "E1", A, "hello wrld"));
  await h.event("message.edited", { id: "false_" + A + "_ED1", from: A, fromMe: false, timestamp: T + 600, body: "hello wrld", editedMessageId: "E1" });
  await h.event("message.edited", { id: "false_" + A + "_ED2", from: A, fromMe: false, timestamp: T + 700, body: "hello world", editedMessageId: "E1" });
  const m = (await h.messages(A))[0];
  assert.deepEqual([m.body, m.edited, m.editedAt], ["hello world", true, new Date((T + 700) * 1000).toISOString()]);
  assert.equal((await h.chats())[0].lastBody, "hello world");
  const info = await h.get("/message-info", { id: m.id });
  assert.deepEqual(info.versions, [
    { body: "helo wrld", at: new Date((T + 1) * 1000).toISOString() },
    { body: "hello wrld", at: new Date((T + 600) * 1000).toISOString() },
    { body: "hello world", at: new Date((T + 700) * 1000).toISOString() },
  ].map((v, i) => (i === 0 ? { ...v, at: info.versions[0].at } : v)));
  assert.equal(info.versions[0].body, "helo wrld");
  assert.equal(info.editedAt, new Date((T + 700) * 1000).toISOString());
  // Edits are not messages: no extra rows, nothing unread added.
  assert.equal((await h.messages(A)).length, 1);
  assert.equal((await h.chats())[0].unread, 1);
});

test("edits out of order: before their message, and the second before the first, end with the newest text and the full history", async () => {
  const h = await harness(plugin, migrations, {});
  await h.event("message.any", editOf(A, "ED9", "E9", A, "third", (T + 900) * 1000));
  await h.event("message.any", editOf(A, "ED8", "E9", A, "second", (T + 800) * 1000));
  assert.equal((await h.messages(A)).length, 0, "an edit alone shows nothing");
  await h.message({ id: "false_" + A + "_E9", from: A, body: "first", timestamp: T + 5 });
  const m = (await h.messages(A))[0];
  assert.deepEqual([m.body, m.edited], ["third", true]);
  const info = await h.get("/message-info", { id: m.id });
  assert.deepEqual(info.versions.map((v) => v.body), ["first", "second", "third"]);
  // The same message coming again (a sync) does not undo the edit.
  await h.message({ id: "false_" + A + "_E9", from: A, body: "first", timestamp: T + 5 });
  assert.equal((await h.messages(A))[0].body, "third");
});

test("caption edits and my own edits from Floq: one version each, even when WAHA echoes the edit back", async () => {
  const h = await harness(plugin, migrations, { waha: () => ({ json: {} }) });
  await h.message({ id: "false_" + A + "_C1", from: A, body: "old caption", hasMedia: true, media: { url: null, mimetype: "image/jpeg" }, _data: { type: "image" } });
  await h.event("message.any", proto(A, "CE1", A, { key: { id: "C1" }, type: 14, editedMessage: { imageMessage: { caption: "new caption" } } }));
  const img = (await h.messages(A))[0];
  assert.deepEqual([img.type, img.body, img.edited], ["image", "new caption", true]);
  await h.message({ id: "true_" + A + "_MY1", to: A, from: ME.id, fromMe: true, body: "my txt" }, { me: ME });
  await h.post("/edit", { messageId: "true_" + A + "_MY1", text: "my text" });
  await h.event("message.edited", { id: "true_" + A + "_MYE", to: A, fromMe: true, timestamp: Math.floor(Date.now() / 1000), body: "my text", editedMessageId: "MY1" }, { me: ME });
  const mine = (await h.messages(A))[1];
  assert.deepEqual([mine.body, mine.edited], ["my text", true]);
  assert.deepEqual((await h.get("/message-info", { id: mine.id })).versions.map((v) => v.body), ["my txt", "my text"]);
});

test("a deleted message that had been edited keeps its last text as the original; an edit after a delete changes nothing shown", async () => {
  const h = await harness(plugin, migrations, {});
  await h.message({ id: "false_" + A + "_X1", from: A, body: "v1" });
  await h.event("message.any", editOf(A, "XE1", "X1", A, "v2"));
  await h.event("message.any", revoke(A, "XR1", "X1", A));
  const m = (await h.messages(A))[0];
  assert.deepEqual([m.deleted, m.edited, m.original.body, m.original.edited], [true, false, "v2", true]);
});

// ---- stickers ----

test("stickers are cached as they arrive, keep their size and animation, and read 'Sticker' in the chat list", async () => {
  const hits = [];
  const h = await harness(plugin, migrations, { waha: files(hits) });
  await h.message({ id: "false_" + A + "_ST1", from: A, hasMedia: true, media: { url: "http://localhost:3000/api/files/st.webp", mimetype: "image/webp" }, _data: { message: { stickerMessage: { mimetype: "image/webp", isAnimated: true, width: 512, height: 512 } } } });
  await sleep(30);
  assert.deepEqual(hits, ["/api/files/st.webp"]);
  const s = (await h.messages(A))[0];
  assert.deepEqual([s.type, s.body, s.media.mime, s.media.animated, s.media.width, s.media.available], ["sticker", "", "image/webp", true, 512, true]);
  const c = (await h.chats())[0];
  assert.deepEqual([c.lastType, c.lastHasMedia, c.lastBody], ["sticker", true, ""]);
  const f = await h.get("/media", { id: s.id });
  assert.equal(f.mime, "image/webp");
  assert.equal(hits.length, 1, "served from the cache");
});
