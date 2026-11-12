// Test harness: the Artifacts tab against a fake client (list newest-first, read, link). Downloads land in window.__links.
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import ArtifactsTab from "@/components/agents/right-sidebar/artifacts-tab";
import { TooltipProvider } from "@/components/ui/tooltip";

const empty = new URLSearchParams(location.search).get("empty") === "1";
const now = Date.now();
const entries = empty ? [] : [
  { name: "report.md", path: "report.md", size: 2048, modifiedAt: now - 5 * 60_000 },
  { name: "chart.png", path: "charts/chart.png", size: 90_000, modifiedAt: now - 3 * 3600_000 },
];
const links: string[] = [];
(window as unknown as { __links: string[] }).__links = links;
const client = {
  baseUrl: "",
  async listArtifacts() { return { dir: "/home/user/Artifacts/p1", entries, truncated: false }; },
  async readArtifact(_s: string, path: string) { return { path, size: 12, binary: false, tooLarge: false, content: "# Hello report" }; },
  async artifactDownloadUrl(_s: string, path: string) { links.push(path); return "#downloaded"; },
  async fileDownloadUrl() { throw new Error("workspace endpoint must not be used"); },
  async readFile() { throw new Error("workspace endpoint must not be used"); },
} as never;
ReactDOM.createRoot(document.getElementById("root")!).render(<TooltipProvider><ArtifactsTab client={client} sessionId="s" active /></TooltipProvider>);
