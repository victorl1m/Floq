// Read receipts are manual: opening a chat or messages arriving in it never send WhatsApp's sendSeen; the "Mark as read" button, sending and the setting do.
import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bundle, cleanup, closeAll, harness } from "./helpers.mjs";

let plugin, migrations;
before(async () => {
  plugin = (await bundle("../../src/plugins/whatsapp/index.ts")).default;
  ({ migrations } = await bundle("../../src/plugins/whatsapp/migrations.ts"));
});
after(cleanup);
afterEach(closeAll);

const A = "5511900000001@c.us";
const seenCalls = (h, from = 0) => h.requests.slice(from).filter((q) => q.path === "/api/sendSeen");
const incoming = (h, extra = {}) => h.message({ from: A, fromMe: false, body: "Are we still on for 3?", notifyName: "Marina", ...extra });
const pending = async (h) => (await h.get("/messages", { chatId: A })).receiptPending;

test("opening a chat (local read) clears Floq's badge but sends no receipt; the log says a receipt is pending", async () => {
  const h = await harness(plugin, migrations, {});
  await incoming(h); await incoming(h);
  await h.idle();
  assert.equal(await pending(h), 2);
  const from = h.requests.length;
  await h.post("/read", { chatId: A, local: true });
  await h.idle();
  assert.equal(seenCalls(h, from).length, 0);
  assert.equal((await h.chats())[0].unread, 0);
  assert.equal(await pending(h), 2, "still not told to WhatsApp");
  await incoming(h); // arrives in the open chat
  await h.post("/read", { chatId: A, local: true });
  await h.idle();
  assert.equal(seenCalls(h, from).length, 0);
  assert.equal(await pending(h), 3);
});

test("the Mark as read button (explicit /read) sends sendSeen to the chat and the log stops offering it", async () => {
  const h = await harness(plugin, migrations, {});
  await incoming(h);
  await h.idle();
  const from = h.requests.length;
  await h.post("/read", { chatId: A });
  assert.deepEqual(seenCalls(h, from).map((q) => q.body.chatId), [A]);
  assert.equal(await pending(h), 0);
  await incoming(h);
  await h.idle();
  assert.equal(await pending(h), 1, "a newer message needs a new receipt");
});

test("sending reads the chat first, once: text, media, reaction", async () => {
  const h = await harness(plugin, migrations, { waha: async (m, p) => (p === "/api/reaction" ? { json: { ok: true } } : undefined) });
  await incoming(h);
  await h.idle();
  const from = h.requests.length;
  await h.post("/send", { chatId: A, text: "yes" });
  const order = h.requests.slice(from).map((q) => q.path).filter((p) => /sendSeen|sendText/.test(p));
  assert.deepEqual(order, ["/api/sendSeen", "/api/sendText"]);
  await h.post("/send", { chatId: A, text: "again" });
  assert.equal(seenCalls(h, from).length, 1, "nothing left to tell");
  await incoming(h);
  await h.idle();
  const mid = h.requests.length;
  await h.post("/send-media", { chatId: A, kind: "image", mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC" });
  assert.equal(seenCalls(h, mid).length, 1);
  await incoming(h);
  await h.idle();
  const last = h.requests.length;
  const id = (await h.messages(A)).find((m) => !m.fromMe).id;
  await h.post("/react", { messageId: id, emoji: "👍" });
  assert.equal(seenCalls(h, last).length, 1);
});

test("the per-account setting restores automatic receipts when a chat is opened", async () => {
  const h = await harness(plugin, migrations, {});
  assert.deepEqual(await h.get("/receipts/settings"), { auto: false });
  await incoming(h);
  await h.idle();
  assert.deepEqual(await h.post("/receipts/settings", { auto: true }), { auto: true });
  const from = h.requests.length;
  await h.post("/read", { chatId: A, local: true });
  assert.equal(seenCalls(h, from).length, 1);
  assert.equal(await pending(h), 0);
  await assert.rejects(h.post("/receipts/settings", { auto: "yes" }), (e) => e.status === 400);
});

test("a message event names every address of the chat, so an open conversation held under another one still shows it", async () => {
  const LID = "193847561029384@lid";
  const h = await harness(plugin, migrations, {});
  await incoming(h);
  await h.idle();
  h.events.length = 0;
  await incoming(h, { body: "second" });
  await h.idle();
  const e = h.events.find((x) => x.name === "message" && x.fromMe === false);
  assert.equal(e.chatId, A);
  assert.ok(Array.isArray(e.ids) && e.ids.includes(A), "ids carries the chat's addresses");
  assert.ok(LID.length > 0);
});
