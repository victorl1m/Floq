// Probe for the organization switch flow: shows what the store exposes; the runtime is mocked by Playwright.
import React from "react";
import ReactDOM from "react-dom/client";
import { RuntimeProvider, useRuntime } from "@/lib/runtime/store";

function Probe() {
  const { organizations, activeOrganizationId, selectOrganization, projects, view, canvasProjectId, openCanvas } = useRuntime();
  return (
    <div>
      <div data-testid="view">{view}:{canvasProjectId ?? ""}</div>
      <div data-testid="org">{activeOrganizationId ?? ""}</div>
      <ul data-testid="projects">{projects.map((p) => <li key={p.id}><button onClick={() => openCanvas(p.id)}>open {p.id}</button></li>)}</ul>
      {organizations.map((o) => <button key={o.id} onClick={() => selectOrganization(o.id)}>switch {o.id}</button>)}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<RuntimeProvider><Probe /></RuntimeProvider>);
