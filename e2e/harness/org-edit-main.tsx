// Harness for editing an organization: the real Organization settings section with the real store; the runtime is mocked by Playwright.
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import OrganizationSection from "@/components/settings/organization-section";
import { OrganizationAvatar } from "@/components/organization/organization-avatar";
import { Toaster } from "@/components/ui/sonner";
import { organizationLabel } from "@/lib/organizations";
import { RuntimeProvider, useRuntime } from "@/lib/runtime/store";

function Probe() {
  const { client, organizations, activeOrganizationId, selectOrganization } = useRuntime();
  const active = organizations.find((o) => o.id === activeOrganizationId);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <div className="flex items-center gap-2" data-testid="switcher-probe">
        {active && <OrganizationAvatar name={organizationLabel(active)} imageUrl={active.imageUrl} className="size-9 rounded-[10px]" />}
        <span data-testid="active-name">{active ? organizationLabel(active) : ""}</span>
        {organizations.map((o) => <button key={o.id} onClick={() => selectOrganization(o.id)}>switch {o.id}</button>)}
      </div>
      {client && <OrganizationSection />}
      <Toaster />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<RuntimeProvider><Probe /></RuntimeProvider>);
