// Delivery ticks: WAHA's ack numbers and names, forward only, matched to our own sends however the id is spelled; the refresh that covers a lost ack webhook.
import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bundle, cleanup, closeAll, harness } from "./helpers.mjs";

let plugin, migrations, acks;
before(async () => { plugin = (await bundle("../../src/plugins/whatsapp/index.ts")).default; ({ migrations } = await bundle("../../src/plugins/whatsapp/migrations.ts")); acks = await bundle("../../src/plugins/whatsapp/acks.ts"); });
afterEach(closeAll);
after(cleanup);

const A = "5511988887777@c.us", LID = "777000111222@lid", G = "120363041234567890@g.us";
const ackOf = async (h, chat = A, i = 0) => (await h.messages(chat))[i].ack;

test("ackOf: numbers, names, ACK_ names and numeric strings; nothing else counts", () => {
  const f = acks.ackOf;
  assert.deepEqual([-1, 0, 1, 2, 3, 4].map((ack) => f({ ack })), [-1, 0, 1, 2, 3, 4]);
  assert.deepEqual(["ERROR", "PENDING", "SERVER", "DEVICE", "READ", "PLAYED"].map((ackName) => f({ ackName })), [-1, 0, 1, 2, 3, 4]);
  assert.equal(f({ ack: "READ" }), 3); assert.equal(f({ ack: "ACK_DEVICE" }), 2); assert.equal(f({ ack: "3" }), 3); assert.equal(f({ ackName: "read" }), 3);
  assert.equal(f({ ack: 9 }), 4); assert.equal(f({ ack: -7 }), -1);
  assert.equal(f({ ack: null, ackName: "SERVER" }), 1, "a null ack falls back to the name instead of meaning PENDING");
  for (const bad of [{}, { ack: null }, { ack: "" }, { ack: true }, { ack: NaN }, { ackName: "WHATEVER" }, { ack: {} }]) assert.equal(f(bad), undefined);
});

test("DEVICE, READ and PLAYED as numbers and as names raise the ticks and tell the UI; a late lower ack changes nothing", async () => {
  const h = await harness(plugin, migrations, {});
  const sent = await h.post("/send", { chatId: A, text: "hi" });
  assert.equal(await ackOf(h), 1);
  h.events.length = 0;
  await h.event("message.ack", { id: sent.id, fromMe: true, ack: 2, ackName: "DEVICE" });
  assert.equal(await ackOf(h), 2);
  assert.deepEqual(h.events.map((e) => [e.name, e.chatId, e.ack]), [["message", A, true]]);
  await h.event("message.ack", { id: sent.id, fromMe: true, ackName: "READ" });
  assert.equal(await ackOf(h), 3, "the name alone is enough");
  await h.event("message.ack", { id: sent.id, fromMe: true, ack: 2 });
  await h.event("message.ack", { id: sent.id, fromMe: true, ack: 1, ackName: "SERVER" });
  await h.event("message.ack", { id: sent.id, fromMe: true, ack: null });
  await h.event("message.ack", { id: sent.id, fromMe: true, ack: -1, ackName: "ERROR" });
  assert.equal(await ackOf(h), 3, "read stays read");
  h.events.length = 0;
  await h.event("message.ack", { id: sent.id, fromMe: true, ack: 3 });
  assert.equal(h.events.length, 0, "no change, no event");
  await h.event("message.ack", { id: sent.id, fromMe: true, ack: "PLAYED" });
  assert.equal(await ackOf(h), 4);
});

test("an error ack marks a message that was not delivered, and a later delivery still raises it", async () => {
  const h = await harness(plugin, migrations, {});
  const sent = await h.post("/send", { chatId: A, text: "hi" });
  await h.event("message.ack", { id: sent.id, fromMe: true, ack: -1 });
  assert.equal(await ackOf(h), -1);
  await h.event("message.ack", { id: sent.id, fromMe: true, ack: 2 });
  assert.equal(await ackOf(h), 2);
});

test("own sends: the id of the send answer and of the ack event can differ in prefix, chat spelling and participant; the stanza id matches them", async () => {
  const stanza = "3EB0A1B2C3D4E5F6";
  for (const [label, sendId, ackIds] of [
    ["id string with the phone chat", `true_${A}_${stanza}`, [`true_${LID}_${stanza}`, `true_${A.replace("@c.us", "@s.whatsapp.net")}_${stanza}`, stanza]],
    ["bare id (NOWEB / GOWS send answer)", stanza, [`true_${A}_${stanza}`, `true_${LID}_${stanza}`]],
    ["id object", { _serialized: `true_${A}_${stanza}` }, [`true_${LID}_${stanza}`]],
  ]) {
    for (const ackId of ackIds) {
      const h = await harness(plugin, migrations, { waha: (method, path, req) => (method === "POST" && path === "/api/sendText" ? { json: { id: sendId } } : undefined) });
      await h.post("/send", { chatId: A, text: "hi" });
      assert.equal(await ackOf(h), 1, label);
      await h.event("message.ack", { id: ackId, from: ackId.includes("@lid") ? LID : A, fromMe: true, ack: 3, ackName: "READ" });
      assert.equal(await ackOf(h), 3, `${label}: ack id ${ackId}`);
      await h.idle(); await closeAll();
    }
  }
});

test("own sends in a group: the ack carries the participant after the stanza", async () => {
  const stanza = "3EB0GROUP0001", me = "5511900000001@c.us";
  const h = await harness(plugin, migrations, { waha: (method, path) => (method === "POST" && path === "/api/sendText" ? { json: { id: `true_${G}_${stanza}_${me}` } } : undefined) });
  await h.post("/send", { chatId: G, text: "hello all" });
  assert.equal(await ackOf(h, G), 1);
  await h.event("message.ack.group", { id: `true_${G}_${stanza}_${me}`, from: G, fromMe: true, participant: "5511911112222@c.us", ack: 3 });
  assert.equal(await ackOf(h, G), 3);
  await h.event("message.ack", { id: `true_${G}_${stanza}`, fromMe: true, ack: 4 });
  assert.equal(await ackOf(h, G), 4);
});

test("an ack never touches a message we received, or one with another id", async () => {
  const h = await harness(plugin, migrations, {});
  await h.message({ from: A, body: "incoming" });
  const incoming = (await h.messages(A))[0];
  await h.event("message.ack", { id: incoming.id, fromMe: false, ack: 3 });
  assert.equal(await ackOf(h), 0);
  const sent = await h.post("/send", { chatId: A, text: "mine" });
  await h.event("message.ack", { id: "true_" + A + "_SOMETHINGELSE", fromMe: true, ack: 3 });
  assert.equal((await h.messages(A)).find((m) => m.id === sent.id).ack, 1);
});

const listOf = (items) => (method, path) => (method === "GET" && /\/chats\/[^/]+\/messages$/.test(path) ? { json: items() } : undefined);

test("refresh: the newest messages come from WAHA and our own unread ones move forward, with the same event as the ack webhook", async () => {
  let items = [];
  const h = await harness(plugin, migrations, { waha: listOf(() => items) });
  const one = await h.post("/send", { chatId: A, text: "one" }), two = await h.post("/send", { chatId: A, text: "two" }), three = await h.post("/send", { chatId: A, text: "three" });
  await h.event("message.ack", { id: three.id, fromMe: true, ack: 3 });
  items = [
    { id: one.id, fromMe: true, ack: 3, ackName: "READ" }, { id: `true_${LID}_${two.id.split("_")[2]}`, fromMe: true, ack: 2, ackName: "DEVICE" },
    { id: three.id, fromMe: true, ack: 2 }, { id: "false_" + A + "_THEIRS", fromMe: false, ack: 3 }, { id: "true_" + A + "_UNKNOWN", fromMe: true, ack: 3 }, null, "x",
  ];
  h.events.length = 0; h.requests.length = 0;
  const r = await h.post("/chats/acks/refresh", { chatId: A });
  assert.deepEqual(r, { updated: 2, pending: 2 });
  const get = h.requests.find((x) => x.method === "GET" && x.path.endsWith("/messages"));
  assert.equal(get.path, `/api/default/chats/${A}/messages`);
  assert.deepEqual(get.query, { limit: "30", downloadMedia: "false" });
  const by = Object.fromEntries((await h.messages(A)).map((m) => [m.id, m.ack]));
  assert.deepEqual([by[one.id], by[two.id], by[three.id]], [3, 2, 3], "read stays read, even when WAHA's list is behind");
  assert.deepEqual(h.events.map((e) => [e.name, e.chatId, e.ack]), [["message", A, true]]);
});

test("refresh is cheap: nothing to update asks WAHA nothing; old, read, failed, received and deleted messages do not count; a WAHA that cannot list is a 502", async () => {
  let items = [], n = 0;
  const list = listOf(() => items);
  const h = await harness(plugin, migrations, { waha: (m, p, r) => (m === "POST" && p === "/api/sendText" ? { json: { id: `true_${r.body.chatId}_UNIQ${++n}` } } : list(m, p, r)) });
  await h.message({ from: A, body: "theirs" });
  const read = await h.post("/send", { chatId: A, text: "read" });
  await h.event("message.ack", { id: read.id, fromMe: true, ack: 3 });
  const bad = await h.post("/send", { chatId: A, text: "failed" });
  await h.event("message.ack", { id: bad.id, fromMe: true, ack: -1 });
  const old = await h.post("/send", { chatId: A, text: "old" });
  await h.sql("UPDATE messages SET sent_at = now() - interval '25 hours' WHERE msg_id = $1", [old.id]);
  h.requests.length = 0;
  assert.deepEqual(await h.post("/chats/acks/refresh", { chatId: A }), { updated: 0, pending: 0 });
  assert.equal(h.requests.length, 0);
  const fresh = await h.post("/send", { chatId: A, text: "fresh" });  items = undefined;
  await assert.rejects(h.post("/chats/acks/refresh", { chatId: A }), { status: 502 });
  items = [{ id: fresh.id, fromMe: true, ack: 3 }];
  assert.equal((await h.post("/chats/acks/refresh", { chatId: A })).updated, 1);
  await assert.rejects(h.post("/chats/acks/refresh", { chatId: A }, "someone-else"), { status: 403 });
  await assert.rejects(h.post("/chats/acks/refresh", {}), { status: 400 });
});

test("refresh reaches a chat saved under its lid or its other phone spelling", async () => {
  let asked = "";
  const h = await harness(plugin, migrations, { waha: (method, path) => { if (method === "GET" && /\/chats\/.+\/messages$/.test(path)) { asked = path; return { json: [] }; } return undefined; } });
  await h.post("/send", { chatId: A, text: "hi" });
  await h.post("/chats/acks/refresh", { chatId: A });
  assert.match(asked, /\/api\/default\/chats\/5511988887777@c\.us\/messages$/);
});

test("the conversation asks for fresh ticks only while one of our messages from the last 24 hours is not read yet", async () => {
  const { needsAckRefresh, ACK_REFRESH_EVERY_MS } = await bundle("../../src/plugins/whatsapp/shared/acks.ts");
  const now = Date.parse("2026-06-01T12:00:00Z"), ago = (h) => new Date(now - h * 3600_000).toISOString();
  const m = (over) => ({ fromMe: true, ack: 1, sentAt: ago(1), ...over });
  assert.equal(ACK_REFRESH_EVERY_MS, 30_000);
  assert.equal(needsAckRefresh(null, now), false);
  assert.equal(needsAckRefresh([], now), false);
  for (const ack of [0, 1, 2, undefined]) assert.equal(needsAckRefresh([m({ ack })], now), true, "ack " + ack);
  for (const ack of [3, 4, -1]) assert.equal(needsAckRefresh([m({ ack })], now), false, "ack " + ack);
  assert.equal(needsAckRefresh([m({ fromMe: false })], now), false);
  assert.equal(needsAckRefresh([m({ sentAt: ago(25) })], now), false);
  assert.equal(needsAckRefresh([m({ pending: true }), m({ failed: true }), m({ deleted: true })], now), false);
  assert.equal(needsAckRefresh([m({ ack: 3 }), m({ ack: 2 })], now), true);
});
