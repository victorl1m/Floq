import { useEffect, useState } from "react";
import { loadHighlighter } from "@/lib/highlighter";

export type LoadedHighlighter = NonNullable<Awaited<ReturnType<typeof loadHighlighter>>>;

/** Lazily loads the highlighter for a language; null while loading, for unknown languages, or on failure. */
export function useHighlighter(language: string | null, enabled = true): LoadedHighlighter | null {
  const [loaded, setLoaded] = useState<{ language: string; value: LoadedHighlighter } | null>(null);
  useEffect(() => {
    if (!language || !enabled) return;
    let cancelled = false;
    loadHighlighter(language).then((value) => { if (!cancelled && value) setLoaded({ language, value }); }).catch(() => {});
    return () => { cancelled = true; };
  }, [language, enabled]);
  return enabled && language && loaded?.language === language ? loaded.value : null;
}
