import { handlePaste, readNativeImage } from "../../src/lib/paste";

// Sandbox headless Chromium crashes on form controls (no system fonts), so a div stands in for the textarea.
const box = document.getElementById("box")!;
const chips = document.getElementById("chips")!;
const add = (name: string) => { const li = document.createElement("li"); li.textContent = name; chips.appendChild(li); };
box.addEventListener("paste", (event) => handlePaste(event, (files) => files.forEach((f) => add(f.name)), (item) => add(item.name)));
(window as unknown as Record<string, unknown>).__readNative = async (mode: "ok" | "fail" | "empty") =>
  (await readNativeImage(async () => { if (mode === "fail") throw new Error("boom"); return mode === "ok" ? new Uint8Array([1, 2, 3]) : null; }))?.name ?? null;
