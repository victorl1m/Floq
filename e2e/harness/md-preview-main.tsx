// Test harness: the Files/Artifacts Markdown preview with a table-heavy document. ?theme=dark
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { DocumentPreview } from "@/components/agents/right-sidebar/files-tab-preview";

if (new URLSearchParams(location.search).get("theme") === "dark") document.documentElement.classList.add("dark");
const MD = `## 0.1 Os números de hoje (linha de base)

| O quê | Número real | O que significa |
|---|---|---|
| Seguidores | **517** (segue 15) | Base pequena, mas **local** |
| Cidade dos seguidores | **62% Uberaba-MG** · 7% Uberlândia | É a **base atual** |
| Reels em 2 meses | **46** (em só 18 dias diferentes) | Posta em "rajadas" e depois some |

## 0.2 Os 6 problemas principais

1. **Reel sem legenda.** 42 de 46 reels não têm texto.`;
const url = URL.createObjectURL(new Blob([MD], { type: "text/markdown" }));
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", overflow: "auto" }} className="bg-background text-foreground">
    <DocumentPreview kind="markdown" path="playbook.md" getUrl={async () => url} onDownload={() => undefined} onOpenExternally={() => undefined} />
  </div>,
);
