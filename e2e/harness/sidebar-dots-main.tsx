// Test harness: the left sidebar inner surface with header/footer stand-ins, to screenshot the pixel-dot ornament on a gradient "desktop".
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";

const q = new URLSearchParams(location.search);
if (q.get("theme") === "dark") document.documentElement.classList.add("dark");
if (q.get("material")) document.documentElement.dataset.nativeMaterial = q.get("material")!;
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100%", padding: 12, background: "linear-gradient(135deg,#6d8fc7,#c78fb3 60%,#e8b97a)" }}>
    <div data-slot="sidebar-inner" style={{ width: 280, height: "100%", display: "flex", flexDirection: "column", borderRadius: 14, overflow: "hidden", background: "var(--shell-pane, var(--sidebar))" }}>
      <div data-slot="sidebar-header" style={{ display: "grid", gap: 8 }}><div className="org-switcher" style={{ height: 56, borderRadius: 12, display: "flex", alignItems: "center", gap: 10, padding: "0 10px" }}><span style={{ width: 36, height: 36, borderRadius: 10, background: "var(--muted)", display: "grid", placeItems: "center", fontWeight: 600, fontSize: 12 }}>FL</span><div style={{ fontSize: 13, lineHeight: 1.25 }}><b>Flowless</b><div style={{ opacity: 0.6, fontSize: 12 }}>Owner · 2 organizations</div></div></div><div style={{ height: 36, border: "1px solid var(--border)", borderRadius: 10, padding: "8px 12px", fontSize: 13 }}>Search</div></div>
      <div data-slot="sidebar-content" style={{ flex: 1, fontSize: 13 }}>Home<br />Tasks<br />Skills &amp; MCP</div>
      <div data-slot="sidebar-footer"><div style={{ height: 44, border: "1px solid var(--border)", borderRadius: 10, padding: "12px", fontSize: 13 }}>Account card</div></div>
    </div>
  </div>,
);
