/** The webview's own context menu (Back, Reload, Save as, Print…) never shows in the app. Custom menus call preventDefault themselves; this catches what is left.
 *  It stays for editable fields (cut / copy / paste / spelling) and when text is selected (copy). */
export function allowsNativeContextMenu(target: EventTarget | null, selection: string): boolean {
  if (selection.trim()) return true;
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return false;
  if (el.closest("input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), textarea, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']")) return true;
  return false;
}

export function suppressNativeContextMenu(doc: Document = document): () => void {
  const onMenu = (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    if (allowsNativeContextMenu(e.target, doc.defaultView?.getSelection()?.toString() ?? "")) return;
    e.preventDefault();
  };
  doc.addEventListener("contextmenu", onMenu);
  return () => doc.removeEventListener("contextmenu", onMenu);
}
