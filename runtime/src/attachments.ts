import { createWriteStream, rmSync } from "node:fs";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { badRequest, HttpError } from "./errors.js";

/** Safety cap for one streamed upload; override with FLOQ_MAX_UPLOAD_BYTES. */
export const DEFAULT_MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;

/** A single path component the user may keep as the attachment's file name. */
export function validAttachmentName(name: unknown): name is string {
  return typeof name === "string" && !!name && name !== "." && name !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(name) && Buffer.byteLength(name, "utf8") <= 255;
}

function tooLarge(maxBytes: number): HttpError {
  return new HttpError(413, "payload_too_large", `File exceeds the ${formatBytes(maxBytes)} upload limit`);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${+(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/** Pass-through that fails the pipeline as soon as more than `maxBytes` flow through. */
export function byteLimit(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > maxBytes) done(tooLarge(maxBytes));
      else done(null, chunk);
    },
  });
}

/**
 * Stream `source` into a new file at `destination` (never overwrites). The partial file is
 * removed on any failure: oversize, client abort, short body, full disk. Returns bytes written.
 */
export async function streamToFile(source: Readable, destination: string, maxBytes: number, expected: number | null): Promise<number> {
  if (expected !== null && expected > maxBytes) throw tooLarge(maxBytes);
  const out = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  let written = 0;
  try {
    await pipeline(source, byteLimit(maxBytes), new Transform({ transform(chunk: Buffer, _e, done) { written += chunk.length; done(null, chunk); } }), out);
  } catch (error) {
    rmSync(destination, { force: true });
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOSPC" || code === "EDQUOT") throw new HttpError(507, "insufficient_storage", "Not enough storage space in your workspace for this file");
    if (error instanceof HttpError) throw error;
    if (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "ECONNRESET" || (error as Error)?.name === "AbortError") throw badRequest("Upload was interrupted", "upload_aborted");
    throw error;
  }
  if (written < 1 || (expected !== null && written !== expected)) {
    rmSync(destination, { force: true });
    throw badRequest(written < 1 ? "File is empty" : "Upload ended before the whole file arrived", "invalid_attachment");
  }
  return written;
}
