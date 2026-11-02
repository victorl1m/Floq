import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "next-themes";
import App from "@/App";
import "@/index.css";
import Titlebar from "@/components/window/titlebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import Footer from "@/components/window/footer";
import ErrorBoundary from "@/components/error-boundary";
import { RuntimeProvider } from "@/lib/runtime/store";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RuntimeProvider>
    <SidebarProvider className="pb-(--app-footer-height)">

      <Titlebar />
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </ThemeProvider>
    </SidebarProvider>
    <Footer />
    </RuntimeProvider>
  </React.StrictMode>,
);
