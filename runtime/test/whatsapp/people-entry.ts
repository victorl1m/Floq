// Test entry: the pieces of runtime/index.ts that the people routes need (core, identity, store, inbox, webhook bus), with the three people modules registered.
import type { PluginContext } from "../../src/plugins/sdk.js";
import { createCore } from "../../src/plugins/whatsapp/core.js";
import { createIdentity } from "../../src/plugins/whatsapp/identity.js";
import { createStore } from "../../src/plugins/whatsapp/messages.js";
import { createInbox } from "../../src/plugins/whatsapp/inbox.js";
import { parseEnvelope } from "../../src/plugins/whatsapp/parse.js";
import { registerChats } from "../../src/plugins/whatsapp/chats.js";
import { registerContacts } from "../../src/plugins/whatsapp/contacts.js";
import { registerGroups } from "../../src/plugins/whatsapp/groups.js";
import { createHistory } from "../../src/plugins/whatsapp/history.js";

let running: ReturnType<typeof createCore> | null = null;
export default {
  async stop() { await running?.idle(); },
  start(ctx: PluginContext) {
    const core = createCore(ctx);
    running = core;
    const identity = createIdentity(core, async () => ctx.kv.get("u1", "phone"));
    const store = createStore(core, identity);
    const inbox = createInbox(core, identity, store);
    const deps = { core, identity, store, inbox, history: createHistory(core, identity, store) };
    registerChats(deps); registerContacts(deps); registerGroups(deps);
    ctx.webhooks.on("events", async (req: { json(): unknown }) => {
      const e = parseEnvelope(req.json());
      const owner = await ctx.installOwner(), o = owner && e ? await core.scope(owner, e.session) : null;
      if (e && o) { if (Object.keys(e.me).length) await identity.saveMe(o, e.me); await core.emit(o, e); }
      return { ok: true };
    });
  },
};
