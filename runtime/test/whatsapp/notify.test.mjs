// WhatsApp in Floq's island: when an incoming message becomes a notification, what it carries, and what its buttons do.
import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bundle, cleanup, closeAll, harness } from "./helpers.mjs";

let plugin, migrations, notify;
before(async () => {
  plugin = (await bundle("../../src/plugins/whatsapp/index.ts")).default;
  ({ migrations } = await bundle("../../src/plugins/whatsapp/migrations.ts"));
  notify = await bundle("../../src/plugins/whatsapp/notify.ts");
});
after(cleanup);
afterEach(closeAll);

const A = "5511900000001@c.us", B = "5511900000002@c.us", G = "120363000000000001@g.us", ME = "5511900000009@c.us";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC", "base64");
const start = (opts = {}) => harness(plugin, migrations, { notify: true, ...opts });
const incoming = (h, from, extra = {}) => h.message({ from, fromMe: false, body: "Are we still on for 3?", notifyName: "Marina Duarte", ...extra });

test("an incoming message becomes a notification with sender, preview, reply, mark read and the chat to open; no toast", async () => {
  const h = await start();
  await incoming(h, A);
  await h.idle();
  assert.equal(h.notes.length, 1);
  const n = h.notes[0];
  assert.deepEqual([n.userId, n.kind, n.title, n.body, n.tag], ["u1", "message", "Marina Duarte", "Are we still on for 3?", "default:" + A]);
  assert.deepEqual(n.actions, [{ id: "reply", label: "Reply", input: { placeholder: "Message" } }, { id: "read", label: "Mark read" }]);
  assert.equal(n.actionRoute, "/notify/action");
  assert.deepEqual(n.data, { session: "default", chatId: A });
  assert.deepEqual(n.target, { view: "inbox", params: { chat: A, session: "default" } });
  assert.equal(n.subtitle, undefined); // one account, no group: nothing to add
  assert.equal(h.toasts.length, 0);
});

test("an older Floq (no ctx.notify) still gets the toast", async () => {
  const h = await harness(plugin, migrations, {});
  await incoming(h, A);
  await h.idle();
  assert.deepEqual(h.toasts.map((t) => t.title), ["WhatsApp: Marina Duarte"]);
});

test("no notification for a muted chat, the chat on screen, the user's own chat, an own message, or an account that is switched off", async () => {
  const h = await start({ phone: "+5511900000009" });
  // muted
  await incoming(h, A);
  await h.post("/chat/mute", { chatId: A, until: new Date(Date.now() + 3600_000).toISOString() });
  await incoming(h, A);
  await h.idle();
  assert.equal(h.notes.length, 1);
  // the chat being read
  await h.post("/notify/focus", { chatId: B });
  await incoming(h, B, { notifyName: "Caio Prado" });
  await h.idle();
  assert.equal(h.notes.length, 1);
  // ...until the UI says it is no longer on screen
  await h.post("/notify/focus", { chatId: null });
  await incoming(h, B, { notifyName: "Caio Prado" });
  await h.idle();
  assert.deepEqual(h.notes.map((n) => n.title), ["Marina Duarte", "Caio Prado"]);
  // own chat ("message me" number) and own messages
  await incoming(h, ME, { notifyName: "Me" });
  await h.message({ to: B, fromMe: true, body: "from my phone" });
  await h.idle();
  assert.equal(h.notes.length, 2);
  // switched off for this account
  assert.deepEqual(await h.get("/notify/settings"), { supported: true, enabled: true });
  assert.deepEqual(await h.post("/notify/settings", { enabled: false }), { supported: true, enabled: false });
  await incoming(h, B, { notifyName: "Caio Prado" });
  await h.idle();
  assert.equal(h.notes.length, 2);
  assert.equal(h.toasts.length, 0);
  await assert.rejects(h.post("/notify/settings", { enabled: "yes" }), (e) => e.status === 400);
});

test("a stale focus report expires", async () => {
  const h = await start();
  await h.post("/notify/focus", { chatId: A });
  const real = Date.now;
  Date.now = () => real() + notify.FOCUS_TTL_MS + 1000;
  try { await incoming(h, A); await h.idle(); } finally { Date.now = real; }
  assert.equal(h.notes.length, 1);
});

test("a group message is titled with the group, marked Group, and the sender leads the text; media gets a readable preview", async () => {
  const h = await start();
  await h.sql("INSERT INTO contacts (user_id, session, chat_id, name) VALUES ('u1','default',$1,'Sunday football')", [G]);
  await h.message({ from: G, participant: A, fromMe: false, body: "", hasMedia: true, notifyName: "Rafael Nunes", media: { mimetype: "image/jpeg", url: null }, _data: { type: "image" } });
  await h.idle();
  const n = h.notes[0];
  assert.deepEqual([n.title, n.subtitle, n.body, n.tag], ["Sunday football", "Group", "Rafael Nunes: Photo", "default:" + G]);
  assert.equal(n.actions[0].input.placeholder, "Message Sunday football");
  const P = (m) => notify.previewOf({ body: "", hasMedia: false, media: null, extra: {}, ...m });
  assert.deepEqual([
    P({ type: "ptt", hasMedia: true }), P({ type: "image", body: "look at this", hasMedia: true }), P({ type: "document", media: { filename: "quote.pdf" }, hasMedia: true }),
    P({ type: "location", extra: { location: { live: true } } }), P({ type: "vcard", extra: { vcards: [{ name: "Ana", phones: [] }] } }), P({ type: "poll", extra: { poll: { name: "Lunch?" } } }), P({ type: "chat", body: "  hi\n there " }), P({ type: "chat" }),
  ], ["Voice message", "Photo: look at this", "Document: quote.pdf", "Live location", "Contact: Ana", "Poll: Lunch?", "hi there", "New message"]);
});

test("the avatar rides along only as a small inline image", async () => {
  const pic = (bytes, mime = "image/png") => ({ waha: (method, path) => (/profile-picture|picture/.test(path) ? { json: { profilePictureURL: "https://pps.whatsapp.net/a.png", url: "https://pps.whatsapp.net/a.png" } } : undefined), web: async () => ({ bytes, headers: { "content-type": mime } }) });
  const small = await start(pic(PNG));
  await small.get("/avatar", { chatId: A }).catch(() => undefined);
  await incoming(small, A);
  await small.idle();
  const got = small.notes[0].avatar;
  if (got !== undefined) assert.match(got, /^data:image\/png;base64,/);
  const big = await start(pic(Buffer.alloc(notify.AVATAR_MAX_BYTES + 1, 7)));
  await big.get("/avatar", { chatId: A }).catch(() => undefined);
  await incoming(big, A);
  await big.idle();
  assert.equal(big.notes[0].avatar, undefined);
});

test("reply action: sends from the stored account and chat, marks the chat read, ignores anything else in the body", async () => {
  const h = await start();
  await incoming(h, A);
  await h.idle();
  const before = h.requests.length;
  const r = await h.post("/notify/action", { notificationId: "n1", actionId: "reply", input: "On my way", data: h.notes[0].data, chatId: B });
  await h.idle();
  assert.equal(r.ok, true);
  const sends = h.requests.slice(before).filter((q) => q.path === "/api/sendText");
  assert.deepEqual(sends.map((q) => [q.body.chatId, q.body.text, q.body.session ?? "default"]), [[A, "On my way", "default"]]);
  assert.ok(h.requests.slice(before).some((q) => q.path === "/api/sendSeen" && q.body.chatId === A));
  const [chat] = (await h.chats()).filter((c) => c.chatId === A);
  assert.equal(chat.unread, 0);
  assert.equal((await h.messages(A)).at(-1).body, "On my way");
  await assert.rejects(h.post("/notify/action", { actionId: "reply", input: "", data: h.notes[0].data }), (e) => e.status === 400);
  await assert.rejects(h.post("/notify/action", { actionId: "delete", data: h.notes[0].data }), (e) => e.status === 400 && e.code === "invalid_action");
  await assert.rejects(h.post("/notify/action", { actionId: "read", data: { session: "not-attached", chatId: A } }), (e) => e.status === 404);
  await assert.rejects(h.post("/notify/action", { actionId: "read", data: {} }), (e) => e.status === 400);
  await assert.rejects(h.post("/notify/action", { actionId: "read", data: h.notes[0].data }, "someone-else"), (e) => e.status === 403);
});

test("mark read action: unread goes to zero, WhatsApp gets the read receipt, nothing is sent", async () => {
  const h = await start();
  await incoming(h, A); await incoming(h, A);
  await h.idle();
  assert.equal((await h.chats())[0].unread, 2);
  const before = h.requests.length;
  await h.post("/notify/action", { actionId: "read", data: h.notes.at(-1).data });
  await h.idle();
  assert.equal((await h.chats())[0].unread, 0);
  const after = h.requests.slice(before);
  assert.ok(after.some((q) => q.path === "/api/sendSeen"));
  assert.ok(!after.some((q) => /^\/api\/send(Text|Image|File)/.test(q.path)));
  assert.ok(h.events.some((e) => e.name === "chats"));
});

test("the notification goes away when the chat is read here, answered from the phone, or opened", async () => {
  const h = await start();
  await incoming(h, A);
  await h.idle();
  await h.post("/read", { chatId: A });
  await h.idle();
  assert.deepEqual(h.cleared, ["default:" + A]);
  // nothing to clear for a chat without a live notification
  await h.post("/read", { chatId: B });
  await h.idle();
  assert.equal(h.cleared.length, 1);
  await incoming(h, B, { notifyName: "Caio Prado" });
  await h.message({ to: B, fromMe: true, body: "answered on the phone" });
  await h.idle();
  assert.deepEqual(h.cleared, ["default:" + A, "default:" + B]);
  await incoming(h, A);
  await h.idle();
  await h.post("/notify/focus", { chatId: A });
  await h.idle();
  assert.equal(h.cleared.length, 3);
});

test("a host that refuses the notification (rate limit) never breaks the message", async () => {
  const h = await start({ notify: "fail" });
  await incoming(h, A);
  await h.idle();
  assert.equal((await h.messages(A)).length, 1);
  assert.equal(h.toasts.length, 0);
});

test("two accounts: each notification names its account and replies from it", async () => {
  const h = await start({ kv: { accounts: [{ session: "default", label: "Shop", name: "", phone: "", addedAt: "" }, { session: "personal", label: "Personal", name: "", phone: "", addedAt: "" }] } });
  await incoming(h, A, {}); 
  await h.message({ from: B, fromMe: false, body: "hello", notifyName: "Caio Prado" }, { session: "personal" });
  await h.idle();
  assert.deepEqual(h.notes.map((n) => [n.subtitle, n.tag, n.data.session]), [["Shop", "default:" + A, "default"], ["Personal", "personal:" + B, "personal"]]);
  const before = h.requests.length;
  await h.post("/notify/action", { actionId: "reply", input: "hi", data: h.notes[1].data });
  await h.idle();
  const send = h.requests.slice(before).find((q) => q.path === "/api/sendText");
  assert.equal(send.body.session, "personal");
  // switching one account off leaves the other on
  await h.post("/notify/settings", { enabled: false, session: "personal" });
  await h.message({ from: B, fromMe: false, body: "again", notifyName: "Caio Prado" }, { session: "personal" });
  await incoming(h, A);
  await h.idle();
  assert.equal(h.notes.length, 3);
  assert.equal(h.notes[2].data.session, "default");
});

test("what the integration sends is what the host accepts (the host's own validator, when the runtime is built)", async (t) => {
  let host;
  try { host = await import("../../dist/notifications.js"); } catch { t.skip("runtime not built (npm run build)"); return; }
  const h = await start();
  await h.sql("INSERT INTO contacts (user_id, session, chat_id, name) VALUES ('u1','default',$1,'Sunday football')", [G]);
  await incoming(h, A);
  await h.message({ from: G, participant: A, fromMe: false, body: "x".repeat(900), notifyName: "Rafael Nunes" });
  await h.idle();
  assert.equal(h.notes.length, 2);
  for (const sent of h.notes) {
    const { userId: _u, ...note } = sent;
    const clean = host.cleanPluginNote({ plugin: { id: "waha", name: "WhatsApp", views: ["inbox"] }, note });
    assert.deepEqual(clean.plugin.actions.map((a) => a.id), ["reply", "read"]);
    assert.ok(clean.plugin.actions[0].input);
    assert.equal(clean.priv.route, "/notify/action");
    assert.deepEqual(clean.priv.data, note.data);
    assert.deepEqual(clean.plugin.target, note.target);
    assert.equal(clean.plugin.tag, note.tag);
  }
});

// ---- voice notes and audio played from the island ----
const OGG = Buffer.from("OggS pretend opus voice note");
const voice = (h, from, extra = {}) => h.message({ from, fromMe: false, body: "", hasMedia: true, notifyName: "Marina Duarte", media: { url: "http://localhost:3000/api/files/v1.oga", mimetype: "audio/ogg; codecs=opus" }, _data: { type: "ptt", duration: "7" }, ...extra });
const files = (h) => h.requests.filter((r) => r.path.startsWith("/api/files/")).map((r) => r.path);
const audioCall = (h, n, audio = "fetch") => h.post("/notify/audio", { notificationId: "n1", audio, data: n.data });

test("a voice note becomes a notification with an audio attachment; text has none", async () => {
  const h = await start({ waha: (_m, path) => (path === "/api/files/v1.oga" ? { bytes: OGG } : undefined) });
  await voice(h, A);
  await incoming(h, B, { notifyName: "Caio Prado" });
  await h.idle();
  const [n, text] = h.notes;
  assert.deepEqual([n.title, n.body], ["Marina Duarte", "Voice message"]);
  assert.deepEqual(n.audio, { route: "/notify/audio", played: true, duration: 7 });
  assert.deepEqual(Object.keys(n.data).sort(), ["chatId", "msgId", "session"]);
  assert.match(n.data.msgId, /_M1$/);
  assert.equal(text.audio, undefined);
  assert.deepEqual(text.data, { session: "default", chatId: B });
  // an audio file (not a voice note) plays too; a failed download has nothing to play
  await h.message({ from: A, fromMe: false, body: "", hasMedia: true, notifyName: "Marina Duarte", media: { url: "http://localhost:3000/api/files/song.mp3", mimetype: "audio/mpeg", filename: "song.mp3" }, _data: { type: "audio" } });
  await h.message({ from: B, fromMe: false, body: "", hasMedia: true, notifyName: "Caio Prado", media: { url: null, mimetype: "audio/ogg", error: "failed" }, _data: { type: "ptt" } });
  await h.idle();
  assert.equal(h.notes[2].audio.route, "/notify/audio");
  assert.equal(h.notes[2].audio.duration, undefined);
  assert.equal(h.notes[3].audio, undefined);
});

test("notification audio: the copy cached on arrival is served without asking WAHA again", async () => {
  const h = await start({ waha: (_m, path) => (path === "/api/files/v1.oga" ? { bytes: OGG } : undefined) });
  await voice(h, A);
  await h.idle();
  assert.deepEqual(files(h), ["/api/files/v1.oga"]); // cached when the message arrived
  const before = h.requests.length;
  const r = await audioCall(h, h.notes[0]);
  assert.equal(r.mime, "audio/ogg");
  assert.deepEqual(Buffer.from(r.data, "base64"), OGG);
  assert.equal(h.requests.length, before, "no WAHA call: WAHA may have deleted the file by now");
});

test("notification audio: not cached and gone from WAHA's downloads, it is downloaded again on demand (then cached)", async () => {
  let gone = true;
  const h = await start({ waha: (_m, path, req) => {
    if (path === "/api/files/v1.oga") return undefined; // WAHA cleaned its downloads
    if (/\/chats\/.+\/messages\//.test(path) && req.query.downloadMedia === "true") return gone ? undefined : { json: { media: { url: "http://localhost:3000/api/files/again.oga" } } };
    if (path === "/api/files/again.oga") return { bytes: OGG };
    return undefined;
  } });
  await voice(h, A);
  await h.idle();
  await assert.rejects(audioCall(h, h.notes[0]), (e) => e.status === 404 && e.code === "media_unavailable");
  gone = false;
  const r = await audioCall(h, h.notes[0]);
  assert.deepEqual(Buffer.from(r.data, "base64"), OGG);
  assert.ok(files(h).includes("/api/files/again.oga"));
  const before = h.requests.length;
  assert.deepEqual(Buffer.from((await audioCall(h, h.notes[0])).data, "base64"), OGG);
  assert.equal(h.requests.length, before);
});

test("notification audio: a passing failure is tried again inside the same request (the first Play is enough)", async () => {
  let busy = 0;
  const h = await start({ waha: (_m, path) => {
    if (path.startsWith("/api/files/") || /\/messages\//.test(path)) { if (busy > 0) { busy--; return { status: 500, json: { error: "busy" } }; } return path === "/api/files/v1.oga" ? { bytes: OGG } : undefined; }
    return undefined;
  } });
  busy = 1; // the arrival-time caching fails
  await voice(h, A);
  await h.idle();
  busy = 2; // ...and so does the first try of the player (file address and re-download)
  const r = await audioCall(h, h.notes[0]);
  assert.deepEqual(Buffer.from(r.data, "base64"), OGG);
  assert.equal(busy, 0);
  // WAHA down for good: the error comes back after the tries
  busy = 99;
  const fresh = await start({ waha: () => ({ status: 500, json: {} }) });
  await voice(fresh, A);
  await fresh.idle();
  const t0 = Date.now();
  await assert.rejects(audioCall(fresh, fresh.notes[0]), (e) => e.status === 503 && e.code === "media_busy");
  assert.ok(Date.now() - t0 >= notify.AUDIO_RETRY_MS.reduce((a, b) => a + b, 0) - 50);
});

test("notification audio: played acknowledges that one message to WhatsApp; unknown requests and missing ids are refused", async () => {
  const h = await start({ waha: (_m, path) => (path === "/api/files/v1.oga" ? { bytes: OGG } : undefined) });
  await voice(h, A);
  await h.idle();
  const n = h.notes[0];
  assert.deepEqual(await audioCall(h, n, "played"), { ok: true });
  await h.idle();
  const seen = h.requests.filter((r) => r.path === "/api/sendSeen");
  assert.deepEqual(seen.map((r) => r.body), [{ chatId: A, messageIds: [n.data.msgId], session: "default" }]);
  assert.equal((await h.chats()).find((c) => c.chatId === A).unread, 1, "listening does not mark the chat read in Floq");
  await assert.rejects(audioCall(h, n, "delete"), (e) => e.status === 400);
  await assert.rejects(h.post("/notify/audio", { audio: "fetch", data: { session: "default", chatId: A } }), (e) => e.status === 404);
  await assert.rejects(h.post("/notify/audio", { audio: "fetch", data: { session: "default", chatId: A, msgId: "nope" } }), (e) => e.status === 404);
});

test("the name the user saved for a contact beats the name they set on WhatsApp, in a direct chat, in a group and in the chat list", async () => {
  const h = await start();
  await h.sql("INSERT INTO contacts (user_id, session, chat_id, name, push_name) VALUES ('u1','default',$1,'Márcia (Fiscal)','Márcia Marques Xavier')", [A]);
  await h.sql("INSERT INTO contacts (user_id, session, chat_id, name) VALUES ('u1','default',$1,'Sarah - Fiscal')", [G]);
  await h.message({ from: A, fromMe: false, body: "oi", notifyName: "Márcia Marques Xavier" });
  await h.message({ from: G, participant: A, fromMe: false, body: "Bom dia!", notifyName: "Márcia Marques Xavier" });
  await h.idle();
  assert.deepEqual(h.notes.map((n) => [n.title, n.body]), [["Márcia (Fiscal)", "oi"], ["Sarah - Fiscal", "Márcia (Fiscal): Bom dia!"]]);
  const g = (await h.chats()).find((c) => c.chatId === G);
  assert.equal(g.lastSenderName, "Márcia (Fiscal)");
});

test("without a saved name the WhatsApp name is used, then the number", async () => {
  const h = await start();
  await h.message({ from: A, fromMe: false, body: "oi", notifyName: "Márcia Marques Xavier" });
  await h.idle();
  assert.equal(h.notes[0].title, "Márcia Marques Xavier");
});
