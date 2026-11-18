export type DocKind = "docx" | "sheet" | "pdf" | "audio" | "video" | "markdown" | "json" | "html" | "nopreview";

const KINDS: Record<string, DocKind> = {
  docx: "docx", xlsx: "sheet", xls: "sheet", csv: "sheet", tsv: "sheet", ods: "sheet", pdf: "pdf",
  mp3: "audio", wav: "audio", ogg: "audio", oga: "audio", m4a: "audio", aac: "audio", flac: "audio", opus: "audio",
  mp4: "video", webm: "video", mov: "video", m4v: "video", ogv: "video",
  // Formats the webview cannot decode: the runtime converts them with ffmpeg while streaming. (".ts" is deliberately absent: it is TypeScript far more often than MPEG-TS.)
  wma: "audio", aiff: "audio", aif: "audio", ac3: "audio", amr: "audio",
  wmv: "video", avi: "video", mkv: "video", flv: "video", mpg: "video", mpeg: "video", "3gp": "video", m2ts: "video",
  md: "markdown", markdown: "markdown", json: "json", html: "html", htm: "html",
  pptx: "nopreview", ppt: "nopreview", doc: "nopreview", odt: "nopreview", odp: "nopreview", rtf: "nopreview", pages: "nopreview", numbers: "nopreview", key: "nopreview",
};

/** How a path is previewed when it needs more than plain text/image; null for text/image/other files, which the dialog handles itself. */
export function docKindForPath(path: string): DocKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext ? KINDS[ext] ?? null : null;
}

const TRANSCODE_EXT = /\.(wmv|avi|mkv|flv|mpe?g|3gp|m2ts|wma|aiff?|ac3|amr)$/i;
/** Media the webview cannot play at all: go straight to the runtime's ffmpeg conversion instead of trying the file directly first. */
export function needsTranscode(path: string): boolean { return TRANSCODE_EXT.test(path); }

/** The signed download URL asking the runtime to convert the file to fragmented MP4 while streaming. */
export function transcodeUrl(url: string): string { return `${url}${url.includes("?") ? "&" : "?"}transcode=1`; }

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

/** Previewed as a document but stored as text: Copy reads and copies the text itself (csv/tsv render as sheets, svg as an image). */
const TEXT_DOC_EXT = /\.(md|markdown|json|html?|csv|tsv|svg)$/i;
export function isTextDocument(path: string): boolean { return TEXT_DOC_EXT.test(path); }
