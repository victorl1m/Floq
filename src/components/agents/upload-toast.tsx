import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";

/** Per-file safety cap; the runtime enforces its own (FLOQ_MAX_UPLOAD_BYTES, default 8 GiB). */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_UPLOAD_COUNT = 50;

/** A file to upload: either an in-memory/browser Blob or an absolute path streamed by the Tauri side. */
export interface UploadItem {
    name: string;
    size: number;
    blob?: Blob;
    path?: string;
}

export function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

function formatDuration(seconds: number): string {
    const total = Math.max(1, Math.round(seconds));
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}m ${total % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function invalidUploadName(name: string): boolean {
    return !name || /[\u0000-\u001f\u007f]/.test(name);
}

interface Snapshot {
    index: number;
    count: number;
    name: string;
    fileLoaded: number;
    fileTotal: number;
    batchLoaded: number;
    batchTotal: number;
    speed: number;
    etaSeconds: number | null;
}

function UploadBody({ snapshot }: { snapshot: Snapshot }) {
    const percent = snapshot.batchTotal ? Math.min(100, Math.floor((snapshot.batchLoaded / snapshot.batchTotal) * 100)) : 0;
    return (
        <div data-upload-body className="flex w-full min-w-0 flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-medium">{snapshot.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{snapshot.index} of {snapshot.count}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                <div className="h-full rounded-full bg-primary transition-[width] duration-100" style={{ width: `${percent}%` }} />
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 text-xs tabular-nums text-muted-foreground">
                <span>{percent}% · {formatBytes(snapshot.batchLoaded)} of {formatBytes(snapshot.batchTotal)}</span>
                <span>
                    {snapshot.speed > 0 ? `${formatBytes(snapshot.speed)}/s` : ""}
                    {snapshot.etaSeconds !== null ? ` · ${formatDuration(snapshot.etaSeconds)} left` : ""}
                </span>
            </div>
        </div>
    );
}

export async function uploadTauriPath(client: RuntimeClient, sessionId: string, item: UploadItem, uploadId: string, onProgress: (loaded: number, total: number) => void, signal: AbortSignal) {
    const off = await listen<{ id: string; loaded: number; total: number }>("floq-upload-progress", (event) => {
        if (event.payload.id === uploadId) onProgress(event.payload.loaded, event.payload.total);
    });
    const cancel = () => { void invoke("cancel_dropped_upload", { uploadId }).catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        const body = await invoke<string>("upload_dropped_file", { uploadId, url: client.attachmentStreamUrl(sessionId, item.name), token: client.token, path: item.path });
        const parsed = JSON.parse(body) as { path?: string };
        if (!parsed.path) throw new Error("The runtime did not return a file path");
        return parsed.path;
    } catch (error) {
        if (signal.aborted) throw new Error("Upload cancelled");
        throw new Error(typeof error === "string" ? error : errorMessage(error));
    } finally {
        signal.removeEventListener("abort", cancel);
        off();
    }
}

/**
 * Upload a batch sequentially with ONE toast updated in place (progress bar, MB, speed, ETA, Cancel).
 * Returns the saved container paths of the files that succeeded.
 */
export async function uploadBatch(client: RuntimeClient, sessionId: string, items: UploadItem[]): Promise<{ paths: string[]; failures: number; cancelled: boolean }> {
    const toastId = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    const batchTotal = items.reduce((sum, item) => sum + item.size, 0);
    const started = performance.now();
    const paths: string[] = [];
    const errors: string[] = [];
    let doneBytes = 0;
    let lastRender = 0;
    let speed = 0;
    let lastSample = { time: started, bytes: 0 };

    const render = (index: number, item: UploadItem, fileLoaded: number, force = false) => {
        const now = performance.now();
        if (!force && now - lastRender < 100) return;
        lastRender = now;
        const batchLoaded = doneBytes + fileLoaded;
        if (now - lastSample.time >= 500) {
            const instant = ((batchLoaded - lastSample.bytes) / (now - lastSample.time)) * 1000;
            speed = speed ? speed * 0.7 + instant * 0.3 : instant;
            lastSample = { time: now, bytes: batchLoaded };
        }
        const elapsed = (now - started) / 1000;
        const etaSeconds = elapsed >= 2 && speed > 0 && batchTotal - batchLoaded > 0 && batchTotal >= 2 * 1024 * 1024 ? (batchTotal - batchLoaded) / speed : null;
        toast.loading(
            <UploadBody snapshot={{ index, count: items.length, name: item.name, fileLoaded, fileTotal: item.size, batchLoaded, batchTotal, speed: elapsed >= 1 ? speed : 0, etaSeconds }} />,
            { id: toastId, duration: Infinity, action: { label: "Cancel", onClick: () => controller.abort() } },
        );
    };

    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (controller.signal.aborted) break;
        render(index + 1, item, 0, true);
        try {
            const onProgress = (loaded: number) => render(index + 1, item, Math.min(loaded, item.size));
            let path: string;
            if (item.path) {
                path = await uploadTauriPath(client, sessionId, item, `${toastId}-${index}`, onProgress, controller.signal);
            } else if (item.blob) {
                path = (await client.uploadSessionAttachmentStream(sessionId, item.blob, item.name, onProgress, controller.signal)).path;
            } else {
                throw new Error("Nothing to upload");
            }
            doneBytes += item.size;
            paths.push(path);
        } catch (error) {
            if (controller.signal.aborted) break;
            errors.push(`${item.name}: ${errorMessage(error)}`);
            doneBytes += item.size;
        }
    }

    const cancelled = controller.signal.aborted;
    if (cancelled) {
        toast.info("Upload cancelled", { id: toastId, duration: 4000, description: paths.length ? `${paths.length} ${paths.length === 1 ? "file was" : "files were"} already uploaded.` : "The partial file was removed.", action: undefined });
    } else if (errors.length) {
        toast.error(items.length === 1 ? `Could not upload ${items[0].name}` : `${errors.length} of ${items.length} uploads failed`, { id: toastId, duration: 10_000, description: errors.slice(0, 3).join("\n"), action: undefined });
    } else {
        const label = items.length === 1 ? `Uploaded ${items[0].name} (${formatBytes(items[0].size)})` : `Uploaded ${items.length} files (${formatBytes(batchTotal)})`;
        toast.success(label, { id: toastId, duration: 4000, description: "The saved paths are ready for the terminal.", action: undefined });
    }
    return { paths, failures: errors.length, cancelled };
}


export function shellQuote(value: string): string {
    return "'" + value.replace(/'/g, "'\''") + "'";
}

/** Browser files are streamed from the Blob; nothing is read into memory here. */
export function browserUploadItems(files: File[], onReady: (items: UploadItem[]) => void) {
    if (files.length > MAX_UPLOAD_COUNT) toast.error(`Only the first ${MAX_UPLOAD_COUNT} files will be uploaded`, { description: "Upload the rest in a separate batch." });
    const ready: UploadItem[] = [];
    for (const file of files.slice(0, MAX_UPLOAD_COUNT)) {
        if (file.size < 1 || file.size > MAX_UPLOAD_BYTES || invalidUploadName(file.name)) {
            toast.error(`Could not upload ${file.name || "file"}`, { description: file.size < 1 ? "The file is empty." : file.size > MAX_UPLOAD_BYTES ? "The file is larger than the 8 GiB limit." : "The name contains control characters." });
            continue;
        }
        ready.push({ name: file.name, size: file.size, blob: file });
    }
    onReady(ready);
}

/** Tauri drops give absolute paths; the Rust side reads name and size and later streams the file from disk. */
export async function tauriDropItems(paths: string[]): Promise<UploadItem[]> {
    if (paths.length > MAX_UPLOAD_COUNT) toast.error(`Only the first ${MAX_UPLOAD_COUNT} files will be uploaded`, { description: "Upload the rest in a separate batch." });
    const groups = await Promise.all(paths.slice(0, MAX_UPLOAD_COUNT).map(async (path) => {
        try {
            const info = await invoke<{ name: string; size: number }>("inspect_dropped_file", { path });
            if (invalidUploadName(info.name)) throw "The name contains control characters.";
            return [{ name: info.name, size: info.size, path }] as UploadItem[];
        } catch (error) {
            toast.error(`Could not read ${path.split(/[\/]/).pop() || "file"}`, { description: typeof error === "string" ? error : "This file cannot be uploaded." });
            return [] as UploadItem[];
        }
    }));
    return groups.flat();
}
