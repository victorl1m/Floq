// Test harness: real sidebar primitives with expanded folders, a selected project and an active nav item (?theme=dark, ?material=solid).
import React from "react";
import ReactDOM from "react-dom/client";
import { IconChevronRight, IconFolderOpen, IconHome, IconListCheck } from "@tabler/icons-react";
import "@/index.css";
import "./font-shim";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider } from "@/components/ui/sidebar";
import { RowAction } from "@/components/sidebar/project-folder";

const q = new URLSearchParams(location.search);
if (q.get("theme") === "dark") document.documentElement.classList.add("dark");
if (q.get("material")) document.documentElement.dataset.material = q.get("material")!;

function Folder({ name, children }: { name: string; children: React.ReactNode }) {
  return <SidebarMenuItem><Collapsible defaultOpen className="group/folder">
    <div className="group/folder-row relative">
      <CollapsibleTrigger asChild><SidebarMenuButton className="h-8 pr-20! text-[13px] font-medium"><IconFolderOpen className="text-muted-foreground" /><span className="flex-1">{name}</span></SidebarMenuButton></CollapsibleTrigger>
      <CollapsibleTrigger asChild><RowAction slot="chevron" aria-label={`Collapse ${name}`}><IconChevronRight className="group-data-[state=open]/folder:rotate-90" /></RowAction></CollapsibleTrigger>
    </div>
    <CollapsibleContent><ul className="ml-3 flex flex-col border-l border-sidebar-border/60">{children}</ul></CollapsibleContent>
  </Collapsible></SidebarMenuItem>;
}
const project = (name: string, active = false) => <li key={name} className="canonical-project-row"><SidebarMenuButton isActive={active} className="h-8 text-[13px]"><span>{name}</span></SidebarMenuButton></li>;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100%", padding: 12, background: "linear-gradient(135deg,#6d8fc7,#c78fb3 60%,#e8b97a)" }}>
    <SidebarProvider style={{ minHeight: 0 }}>
      <div data-slot="sidebar-inner" style={{ width: 270, height: "100%", display: "flex", flexDirection: "column", borderRadius: 14, overflow: "hidden", background: "var(--shell-pane, var(--sidebar))" }}>
        <div data-slot="sidebar-header" style={{ height: 70 }} />
        <div data-slot="sidebar-content" style={{ flex: 1 }}>
          <SidebarMenu className="sidebar-nav">
            <SidebarMenuItem><SidebarMenuButton isActive><IconHome /><span>Home</span></SidebarMenuButton></SidebarMenuItem>
            <SidebarMenuItem><SidebarMenuButton><IconListCheck /><span>Tasks</span></SidebarMenuButton></SidebarMenuItem>
          </SidebarMenu>
          <SidebarMenu style={{ marginTop: 16 }}>
            <Folder name="Neotalk"><Folder name="APIs">{project("API Core")}{project("API Thais")}</Folder>{project("Thais")}</Folder>
            <Folder name="Pessoal"><Folder name="Floq">{project("Floq", true)}</Folder></Folder>
          </SidebarMenu>
        </div>
        <div data-slot="sidebar-footer"><div style={{ height: 44, padding: 12, fontSize: 13, fontWeight: 600 }} title="Victor Hugo Lima e Silva">Victor Silva</div></div>
      </div>
    </SidebarProvider>
  </div>,
);
