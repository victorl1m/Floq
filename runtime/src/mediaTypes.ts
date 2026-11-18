import { extname } from "node:path";

/** Audio/video types served with their real Content-Type so <audio>/<video> can play them (WebKit rejects octet-stream + nosniff). Never includes anything active such as html or svg. */
const MEDIA_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".opus": "audio/ogg",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogv": "video/ogg",
};

export function downloadContentType(name: string): string {
  return MEDIA_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}
