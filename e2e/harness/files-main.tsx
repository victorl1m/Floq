// Test harness: the Files tab's read-only file dialog against a fake client. `?theme=dark` toggles the dark class.
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import FileDialog from "@/components/agents/right-sidebar/files-tab-file-dialog";

if (new URLSearchParams(location.search).get("theme") === "dark") document.documentElement.classList.add("dark");
const content = Array.from({ length: 120 }, (_, i) => `export const value${i} = ${i}; // line ${i + 1}`).join("\n") + "\n";
const client = {
  async readFile(_s: string, path: string) { return { path, size: content.length, binary: false, tooLarge: false, content }; },
  async fileDownloadUrl() { return "about:blank"; },
} as never;
ReactDOM.createRoot(document.getElementById("root")!).render(<FileDialog client={client} sessionId="s" path="src/components/deep/example.ts" onClose={() => document.title = "closed"} />);
