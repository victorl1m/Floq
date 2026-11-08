import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../dist/manager.js";

const USER = "user-1";
const PROJECT = "11111111-1111-4111-8111-111111111111";

/** In-memory floq_projects row behind just the SQL updateProject/listProjects issue. */
function makeManager() {
  const row: Record<string, unknown> = { id: PROJECT, user_id: USER, name: "demo", display_name: null, image_url: null, icon_name: null, icon_color: null, git_url: null, cwd: "/tmp/demo", created_at: "2026-01-01T00:00:00Z" };
  const updates: string[] = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith("UPDATE floq_projects")) {
        updates.push(sql);
        const assignments = /SET (.*) WHERE/.exec(sql)![1].split(",");
        for (const assignment of assignments) {
          const [column, param] = assignment.split("=");
          row[column] = values[Number(/\$(\d+)/.exec(param)![1]) - 1];
        }
        return { rows: [{ id: PROJECT }] };
      }
      if (sql.startsWith("SELECT * FROM floq_projects")) return { rows: [{ ...row }] };
      if (sql.includes("floq_project_workspaces")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const manager = Object.create(SessionManager.prototype);
  manager.pool = pool;
  manager.shards = { awakeHandle: () => undefined };
  return { manager, row, updates };
}

test("updateProject stores icon fields and listProjects returns them", async () => {
  const { manager } = makeManager();
  const updated = await manager.updateProject(USER, PROJECT, { iconName: "rocket", iconColor: "#3b82f6", imageUrl: null });
  assert.equal(updated.iconName, "rocket");
  assert.equal(updated.iconColor, "#3b82f6");
  assert.equal(updated.imageUrl, null);
  const [listed] = await manager.listProjects(USER);
  assert.equal(listed.iconName, "rocket");
  assert.equal(listed.iconColor, "#3b82f6");
});

test("updateProject clears icon fields with null and leaves omitted fields alone", async () => {
  const { manager, row } = makeManager();
  await manager.updateProject(USER, PROJECT, { iconName: "rocket", iconColor: "#3b82f6" });
  await manager.updateProject(USER, PROJECT, { displayName: "Renamed" });
  assert.equal(row.icon_name, "rocket");
  const cleared = await manager.updateProject(USER, PROJECT, { iconName: null, iconColor: null });
  assert.equal(cleared.iconName, null);
  assert.equal(cleared.iconColor, null);
  assert.equal(cleared.displayName, "Renamed");
});

test("updateProject rejects malformed icon fields with 400 and writes nothing", async () => {
  const { manager, updates } = makeManager();
  for (const patch of [{ iconName: "Rocket" }, { iconName: "x y" }, { iconName: 5 }, { iconColor: "red" }, { iconColor: "#fff" }]) {
    await assert.rejects(() => manager.updateProject(USER, PROJECT, patch), (error: { status?: number; statusCode?: number }) => (error.status ?? error.statusCode) === 400);
  }
  assert.equal(updates.length, 0);
});
