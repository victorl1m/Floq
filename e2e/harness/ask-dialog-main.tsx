// Test harness: the promise-based confirm dialog. Buttons open a wake-style confirm (enterConfirms) and a plain one; results land in window.__results.
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { AskDialogHost, askConfirm } from "@/components/ui/ask-dialog";

const q = new URLSearchParams(location.search);
if (q.get("theme") === "dark") document.documentElement.classList.add("dark");
const w = window as unknown as { __results: Array<[string, boolean]> };
w.__results = [];
const ask = async (name: string, opts: Parameters<typeof askConfirm>[0]) => { w.__results.push([name, await askConfirm(opts)]); };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="flex gap-2 p-6">
      <button data-testid="wake" onClick={() => void ask("wake", { title: "Wake Orchestrator?", description: "Orchestrator is not running. Floq wakes it, then sends your message.", actionLabel: "Wake and send", enterConfirms: true })}>wake</button>
      <button data-testid="plain" onClick={() => void ask("plain", { title: "Delete this?", actionLabel: "Delete", destructive: true, enterConfirms: true })}>plain</button>
    </div>
    <AskDialogHost />
  </React.StrictMode>,
);
