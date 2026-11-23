// Counts renders for Floq's e2e specs: inert unless the page defines window.__waRenders (the app never does).
export function countRender(name: string): void {
  const probe = (globalThis as { __waRenders?: Record<string, number> }).__waRenders;
  if (probe) probe[name] = (probe[name] ?? 0) + 1;
}
