import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconX } from "@tabler/icons-react";
import { cn } from "cn";
import { browserUploadItems, formatBytes, tauriDropItems, type UploadItem } from "@/components/agents/upload-toast";
import { FileIcon } from "@/components/agents/right-sidebar/file-icons";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { Attachment } from "./canvas-send";

let counter = 0;

/** Attachment list with object-URL previews that are revoked on removal and unmount. */
export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const add = useCallback((incoming: UploadItem[]) => {
    const made = incoming.map<Attachment>((item) => ({
      ...item,
      id: `att-${Date.now()}-${counter++}`,
      previewUrl: item.blob && item.blob.type.startsWith("image/") ? URL.createObjectURL(item.blob) : undefined,
    }));
    if (made.length) setItems((list) => [...list, ...made]);
  }, []);
  const addFiles = useCallback((files: File[]) => browserUploadItems(files, add), [add]);
  const remove = useCallback((id: string) => {
    setItems((list) => {
      const gone = list.find((item) => item.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return list.filter((item) => item.id !== id);
    });
  }, []);
  const clear = useCallback(() => {
    for (const item of itemsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setItems([]);
    setProgress({});
  }, []);
  const setFraction = useCallback((id: string, fraction: number) => setProgress((current) => ({ ...current, [id]: fraction })), []);
  const resetProgress = useCallback(() => setProgress({}), []);
  useEffect(() => () => { for (const item of itemsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); }, []);
  return { items, progress, add, addFiles, remove, clear, setFraction, resetProgress };
}

/** Tauri swallows browser drops and reports paths for the whole window: accept the ones landing inside `ref`. */
export function useTauriDrop(ref: React.RefObject<HTMLElement | null>, onItems: (items: UploadItem[]) => void, setHover: (hover: boolean) => void) {
  const handler = useRef(onItems);
  handler.current = onItems;
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "leave") { setHover(false); return; }
      const rect = ref.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const x = event.payload.position.x / window.devicePixelRatio;
      const y = event.payload.position.y / window.devicePixelRatio;
      const over = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (event.payload.type === "enter" || event.payload.type === "over") { setHover(over); return; }
      setHover(false);
      if (event.payload.type === "drop" && over) void tauriDropItems(event.payload.paths).then((items) => handler.current(items));
    }).then((unlisten) => { if (disposed) unlisten(); else off = unlisten; }).catch(() => undefined);
    return () => { disposed = true; off?.(); };
  }, [ref, setHover]);
}

function Ring({ value }: { value: number }) {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 20 20" className="size-5 -rotate-90">
      <circle cx="10" cy="10" r={radius} fill="none" strokeWidth="2.5" className="stroke-foreground/20" />
      <circle cx="10" cy="10" r={radius} fill="none" strokeWidth="2.5" strokeLinecap="round" className="stroke-primary transition-[stroke-dashoffset]" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - value)} />
    </svg>
  );
}

export function AttachmentChips({ items, progress, uploading, onRemove, small }: { items: Attachment[]; progress: Record<string, number>; uploading: boolean; onRemove: (id: string) => void; small?: boolean }) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  if (!items.length) return null;
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => {
          const value = progress[item.id];
          const busy = uploading && value !== undefined && value < 1;
          return (
            <div key={item.id} className={cn("group/chip relative flex animate-in items-center gap-1.5 overflow-hidden rounded-lg border border-border bg-muted/60 fade-in zoom-in-95 motion-reduce:animate-none", small ? "h-6 max-w-40 pr-5 pl-1 text-[10px]" : "h-9 max-w-52 pr-6 pl-1.5 text-[11px]")}>
              {item.previewUrl ? (
                <button type="button" className="shrink-0 cursor-zoom-in" aria-label={`Preview ${item.name}`} onClick={() => setPreview(item)}>
                  <img src={item.previewUrl} alt="" className={cn("rounded object-cover", small ? "size-4" : "size-6")} />
                </button>
              ) : <FileIcon name={item.name} className={small ? "size-3" : "size-4"} />}
              <span className="min-w-0 flex-1 truncate" title={item.name}>{item.name}</span>
              {!small && <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(item.size)}</span>}
              {uploading && value !== undefined && <span className="shrink-0" title={`${Math.round(value * 100)}%`}>{busy ? <Ring value={value} /> : null}</span>}
              <Button variant="ghost" size="icon-xs" type="button" aria-label={`Remove ${item.name}`} disabled={uploading} className="absolute inset-y-0 right-1 my-auto size-4 rounded-full text-muted-foreground" onClick={() => onRemove(item.id)}>
                <IconX size={small ? 10 : 12} />
              </Button>
            </div>
          );
        })}
      </div>
      <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <DialogContent className="max-w-[min(900px,92vw)] sm:max-w-[min(900px,92vw)]">
          <DialogTitle className="truncate font-mono text-xs">{preview?.name}</DialogTitle>
          {preview?.previewUrl && <img src={preview.previewUrl} alt={preview.name} className="max-h-[70vh] w-full rounded-md object-contain" />}
        </DialogContent>
      </Dialog>
    </>
  );
}
