// Translates a browser KeyboardEvent into the bytes a terminal program expects (xterm-style, normal cursor mode).
export interface KeyLike { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }

const CSI_LETTER: Record<string, string> = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };
const CSI_TILDE: Record<string, number> = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const SS3: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };

/** The bytes for a key press, or null when the key should not go to the terminal (Cmd shortcuts, bare modifiers, unknown keys). */
export function keyToSequence(e: KeyLike): string | null {
  if (e.metaKey) return null;
  const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
  const { key } = e;
  if (key === "Enter") return e.shiftKey ? "\n" : e.altKey ? "\x1b\r" : "\r";
  if (key === "Backspace") return e.altKey ? "\x1b\x7f" : e.ctrlKey ? "\x08" : "\x7f";
  if (key === "Tab") return e.shiftKey ? "\x1b[Z" : "\t";
  if (key === "Escape") return "\x1b";
  if (key in CSI_LETTER) return mod === 1 ? "\x1b[" + CSI_LETTER[key] : "\x1b[1;" + mod + CSI_LETTER[key];
  if (key in CSI_TILDE) return "\x1b[" + CSI_TILDE[key] + (mod === 1 ? "" : ";" + mod) + "~";
  if (key in SS3) return mod === 1 ? "\x1bO" + SS3[key] : "\x1b[1;" + mod + SS3[key];
  if (key.length === 1) {
    if (e.ctrlKey && !e.altKey) {
      const lower = key.toLowerCase();
      if (lower >= "a" && lower <= "z") return String.fromCharCode(lower.charCodeAt(0) - 96);
      if (key === " " || key === "@") return "\x00";
      if (key === "[") return "\x1b";
      if (key === "\\") return "\x1c";
      if (key === "]") return "\x1d";
      if (key === "^" || key === "6") return "\x1e";
      if (key === "_" || key === "/") return "\x1f";
      return null;
    }
    return e.altKey ? "\x1b" + key : key;
  }
  return null;
}

/** Keys worth forwarding from the message bar while it is empty: navigation, control and mode keys, never plain characters. */
export function isControlKey(e: KeyLike): boolean {
  if (e.metaKey) return false;
  // Paste shortcuts belong to the input's own paste (text or image chip); forwarding Ctrl+V (\x16) makes Claude Code answer "No image found in clipboard".
  if (e.key.length === 1 && e.ctrlKey && e.key.toLowerCase() === "v") return false;
  if (e.key === "Insert" && e.shiftKey) return false;
  if (e.key.length === 1) return e.ctrlKey && !e.altKey && keyToSequence(e) !== null && e.key.toLowerCase() !== "d";
  return keyToSequence(e) !== null && e.key !== "Backspace" && e.key !== "Delete";
}
