import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "next-themes";
import App from "@/App";
import IslandRoot from "@/components/island/island-root";
import { applyCursorPreference } from "@/lib/cursor-preference";


import Titlebar from "@/components/window/titlebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import Footer from "@/components/window/footer";
import ErrorBoundary from "@/components/error-boundary";
import { RuntimeProvider } from "@/lib/runtime/store";
import { useRuntime } from "@/lib/runtime/store";
import { PluginsProvider } from "@/plugins/host";

function PersistedSidebarProvider({ children }: { children: React.ReactNode }) {
    const { userPreferences, updateUserPreferences } = useRuntime();
    return <SidebarProvider
        open={userPreferences.sidebarOpen}
        onOpenChange={(open) => updateUserPreferences({ sidebarOpen: open })}
    >
        {children}
    </SidebarProvider>;
}

const island = new URLSearchParams(window.location.search).get("window") === "island";
if (island) void import("@/island.css");
else { void import("@/index.css"); applyCursorPreference(); }

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(island ? (
  <React.StrictMode><ThemeProvider attribute={["class", "data-theme"]} defaultTheme="system" enableSystem><IslandRoot /></ThemeProvider></React.StrictMode>
) : (
  <React.StrictMode>
    <RuntimeProvider>
    <PluginsProvider>
    <PersistedSidebarProvider>

      <Titlebar />
      <ThemeProvider
        attribute={["class", "data-theme"]}
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </ThemeProvider>
    </PersistedSidebarProvider>
    <Footer />
    </PluginsProvider>
    </RuntimeProvider>
  </React.StrictMode>
));
