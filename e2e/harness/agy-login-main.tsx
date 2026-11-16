// Test harness: Accounts section + Antigravity Google-login connect dialog with a stub client. ?connected=1 starts signed in.
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { Toaster } from "@/components/ui/sonner";
import { RuntimeContext } from "@/lib/runtime/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import AccountsSection from "@/components/settings/accounts-section";
import { useUsableProviders } from "@/components/agents/use-usable-providers";
import type { UserSettings } from "@/lib/runtime/types";

const q = new URLSearchParams(location.search);
const w = window as unknown as { __calls: Array<{ name: string; args: unknown }>; __agyConnected: boolean };
w.__calls = [];
w.__agyConnected = q.get("connected") === "1";
const session = { id: "login-1", provider: "antigravity", state: "running", exitCode: null, startedAt: 1, seq: 0, title: "Antigravity login", cwd: "" };
const client = {
  providersStatus: async () => ({ claude: { connected: false }, codex: { connected: false }, antigravity: { connected: w.__agyConnected } }),
  providerLogin: async (id: string) => { w.__calls.push({ name: "login", args: id }); return session; },
  providerLogout: async (id: string) => { w.__calls.push({ name: "logout", args: id }); w.__agyConnected = false; },
  sendInput: async (id: string, data: string) => { w.__calls.push({ name: "input", args: [id, data] }); w.__agyConnected = true; },
  deleteSession: async (id: string) => { w.__calls.push({ name: "delete", args: id }); },
  streamUrl: () => "ws://agy.test/stream",
  claudeAccounts: async () => [],
};
const info = {
  server: { providers: ["claude", "codex", "antigravity"] },
  providers: [
    { id: "claude", available: true },
    { id: "codex", available: true },
    { id: "antigravity", available: true, needsApiKey: "GEMINI_API_KEY", apiKeyConfigured: false, oauthConnected: q.get("connected") === "1" },
  ],
};

function Usable() {
  const { usable } = useUsableProviders();
  return <div data-testid="usable">{usable.join(",")}</div>;
}

function App() {
  const [settings] = useState({ claudeAutoApprove: true, codexAutoApprove: true, gitName: null, gitEmail: null, github: null } as UserSettings);
  return (
    <div className="bg-background p-4 text-foreground" style={{ maxWidth: 720 }}>
      <AccountsSection settings={settings} onChange={() => {}} />
      <Usable />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <RuntimeContext.Provider value={{ client, info, sessions: [], upsertSession: () => {} } as never}><TooltipProvider><App /><Toaster /></TooltipProvider></RuntimeContext.Provider>,
);
