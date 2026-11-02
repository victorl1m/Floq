/** Project images are rendered directly by the browser; the runtime never fetches them. */
export function normalizeProjectImageUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Resolve a site's own favicon without routing the request through a third party. */
export function projectFaviconUrl(raw: string): string | null {
  const normalized = normalizeProjectImageUrl(raw);
  if (!normalized) return null;
  try {
    return new URL("/favicon.ico", normalized).toString();
  } catch {
    return null;
  }
}
