// Test harness: the Files tab explorer against an in-memory fake file system (list, read, create). Created calls land in window.__created.
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import FilesTab from "@/components/agents/right-sidebar/files-tab";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { TooltipProvider } from "@/components/ui/tooltip";

if (new URLSearchParams(location.search).get("theme") === "dark") document.documentElement.classList.add("dark");
const fs = new Map<string, "dir" | "file">([["src", "dir"], ["src/lib", "dir"], ["empty", "dir"], ["README.md", "file"], ["src/index.ts", "file"], ["report.docx", "file"], ["data.xlsx", "file"], ["table.csv", "file"], ["paper.pdf", "file"], ["huge.pdf", "file"], ["deck.pptx", "file"], ["links.docx", "file"], ["huge.xlsx", "file"]]);
const created: unknown[] = [];
const dataUrl = (bytes: Uint8Array | string, type: string) => `data:${type};base64,${typeof bytes === "string" ? btoa(bytes) : btoa(String.fromCharCode(...bytes))}`;
async function fixture(path: string): Promise<string> {
  if (path === "report.docx" || path === "links.docx") {
    const link = path === "links.docx";
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    if (link) zip.file("word/_rels/document.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/page" TargetMode="External"/></Relationships>');
    zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Hello from the docx fixture</w:t></w:r>${link ? '<w:hyperlink r:id="rId9"><w:r><w:t>Visit example</w:t></w:r></w:hyperlink>' : ""}</w:p></w:body></w:document>`);
    return dataUrl(await zip.generateAsync({ type: "uint8array" }), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  }
  if (path === "data.xlsx") {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Name", "Qty"], ["Apples", 3]]), "Fruit");
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["City"], ["Lisbon"]]), "Cities");
    return dataUrl(new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" })), "application/octet-stream");
  }
  if (path === "huge.xlsx") {
    // Declares a range of 16384 x 1048576 cells but holds two cells: parsing must stay bounded. The XML is patched by hand because XLSX.write would expand the range itself.
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["first"]]), "Huge");
    const zip = await JSZip.loadAsync(new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" })));
    const xml = (await zip.file("xl/worksheets/sheet1.xml")!.async("string"))
      .replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:XFD1048576"/>')
      .replace("</sheetData>", '<row r="1048576"><c r="XFD1048576" t="inlineStr"><is><t>far</t></is></c></row></sheetData>');
    zip.file("xl/worksheets/sheet1.xml", xml);
    return dataUrl(await zip.generateAsync({ type: "uint8array" }), "application/octet-stream");
  }
  if (path === "table.csv") return dataUrl("a,b\n1,2\n", "text/csv");
  if (path === "paper.pdf") return dataUrl("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF", "application/pdf");
  if (path === "huge.pdf") return dataUrl("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 14000 9000]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF", "application/pdf");
  return dataUrl("x", "application/octet-stream");
}
(window as unknown as { __created: unknown[] }).__created = created;
const childrenOf = (dir: string) => [...fs].filter(([path]) => (dir === "" ? !path.includes("/") : path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/")));
const client = {
  async listFiles(_s: string, path = "") {
    return { path, truncated: false, entries: childrenOf(path).map(([p, type]) => ({ name: p.split("/").pop()!, path: p, type })) };
  },
  async readFile(_s: string, path: string) { return { path, size: 0, binary: false, tooLarge: false, content: "" }; },
  async gitChanges() { throw new Error("not a git repository"); },
  async fileDownloadUrl(_s: string, path: string) { return fixture(path); },
  async createFileEntry(_s: string, parent: string, name: string, kind: "file" | "dir") {
    const path = parent ? `${parent}/${name}` : name;
    created.push({ parent, name, kind });
    if (name === "boom") throw Object.assign(new Error("Permission denied by the server"), { status: 403 });
    if (fs.has(path)) throw Object.assign(new Error("A file or folder with that name already exists"), { status: 409 });
    fs.set(path, kind);
    return { path, type: kind };
  },
} as never;
const targets = [{ id: "w", label: "main", branch: null, sessionId: "s" }];
ReactDOM.createRoot(document.getElementById("root")!).render(<TooltipProvider><FilesTab client={client} targets={targets} /></TooltipProvider>);
