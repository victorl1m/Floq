// Test harness: the right sidebar pane with the Conversations group headers (same classes as conversations-tab.tsx).
// Sets data-material like App.tsx; ?native=acrylic adds data-native-material, ?theme=dark, ?material=solid.
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";

const q = new URLSearchParams(location.search);
if (q.get("theme") === "dark") document.documentElement.classList.add("dark");
document.documentElement.dataset.material = q.get("material") ?? "glass";
if (q.get("native")) document.documentElement.dataset.nativeMaterial = q.get("native")!;

const groups = [["Recent", 5], ["Closed · Today", 8]] as const;
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100%", padding: 12, background: "linear-gradient(135deg,#6d8fc7,#c78fb3 60%,#e8b97a)" }}>
    <aside className="floq-right-sidebar flex flex-col overflow-hidden border border-border/70 rounded-(--shell-radius)" style={{ width: 360, height: 480 }}>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {groups.map(([label, n]) => (
          <section key={label} aria-label={label} className="mb-1">
            <h3 className="floq-sticky-head sticky top-0 z-[1] flex items-center justify-between px-2 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {label}<span className="tabular-nums normal-case">{n}</span>
            </h3>
            <ul className="flex flex-col gap-px">
              {Array.from({ length: n }, (_, i) => <li key={i} className="h-9 rounded-md px-2 text-sm font-semibold">Conversation {label} {i + 1}</li>)}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  </div>,
);
