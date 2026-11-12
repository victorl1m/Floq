// Test harness: New Agent dialog with a fake runtime context. Role is mirrored in document.title on create.
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import NewAgentDialog from "@/components/agents/new-agent-dialog";
import { RuntimeContext } from "@/lib/runtime/store";

const roles = [
  ["specifier", "Specifier", "Turns a request into a clear spec"], ["planner", "Planner", "Breaks work into steps"],
  ["implementer", "Implementer", "Writes the code"], ["reviewer", "Reviewer", "Reviews changes"],
  ["tester", "Tester", "Writes and runs tests"], ["orchestrator", "Orchestrator", "Coordinates other agents"],
].map(([id, label, summary]) => ({ id, label, summary, icon: id, capability: "balanced", readOnly: false, whenToUse: "" }));
const client = {
  async agentRoles() { return roles; },
  async providersStatus() { return { claude: { connected: true }, codex: { connected: true } }; },
  async createSession(input: { role?: string }) { document.title = `created:${input.role ?? "none"}`; throw new Error("stop"); },
} as never;
const value = {
  client, info: null, newAgentOpen: true, newAgentOrigin: null, setNewAgentOpen() {}, upsertSession() {}, openSession() {}, focusOnCanvas() {},
  view: "home", refresh: async () => {}, projects: [{ id: "p1", name: "Demo" }], projectsLoading: false, activeProjectId: "p1", activeWorkspaceId: "w1", selectProject() {}, createProject: async () => null,
} as never;
ReactDOM.createRoot(document.getElementById("root")!).render(<RuntimeContext.Provider value={value}><NewAgentDialog /></RuntimeContext.Provider>);
