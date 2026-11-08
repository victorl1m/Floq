import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconBox, IconPhotoUp, IconSearch, IconTrash, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PROJECT_ICONS, PROJECT_ICON_CATEGORIES } from "@/components/projects/project-icon-catalog";
import { ProjectMark } from "@/components/projects/project-identity";
import { normalizeProjectImageUrl, projectFaviconUrl } from "@/lib/runtime/project-appearance";
import { errorMessage } from "@/lib/runtime/store";
import { cn } from "cn";

const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 32 * 1024;
const THUMBNAIL_SIZE = 128;
const MAX_SOURCE_PIXELS = 25_000_000;
const SOURCE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const EMBEDDED_PREFIX = "data:image/webp;base64,";

export const ICON_COLORS: ReadonlyArray<{ value: string | null; label: string }> = [
  { value: null, label: "Default" },
  { value: "#ef4444", label: "Red" },
  { value: "#f97316", label: "Orange" },
  { value: "#eab308", label: "Yellow" },
  { value: "#22c55e", label: "Green" },
  { value: "#14b8a6", label: "Teal" },
  { value: "#3b82f6", label: "Blue" },
  { value: "#8b5cf6", label: "Violet" },
  { value: "#ec4899", label: "Pink" },
];

type Fit = "cover" | "contain";
type ImageSource = "file" | "url" | "favicon";

/** Width/height from the file header (PNG, GIF, WebP, JPEG) without decoding pixels; null when it cannot be read. */
export async function readImageDimensions(file: Blob): Promise<{ width: number; height: number } | null> {
  const b = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
  const u16be = (o: number) => (b[o] << 8) | b[o + 1];
  const u16le = (o: number) => b[o] | (b[o + 1] << 8);
  const u24le = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  const ascii = (o: number, text: string) => [...text].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, "PNG")) return { width: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, height: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 };
  if (b.length >= 10 && ascii(0, "GIF8")) return { width: u16le(6), height: u16le(8) };
  if (b.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8X")) return { width: u24le(24) + 1, height: u24le(27) + 1 };
    if (ascii(12, "VP8L") && b[20] === 0x2f) { const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] * 2 ** 24); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
    if (ascii(12, "VP8 ")) return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o += 1; continue; }
      const marker = b[o + 1];
      if (marker === 0xff) { o += 1; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: u16be(o + 5), width: u16be(o + 7) };
      o += 2 + u16be(o + 2);
    }
  }
  return null;
}

/** Render the file into a square 128×128 WebP: "cover" crops to the center, "contain" letterboxes with transparency. */
export async function projectImageThumbnail(file: File, fit: Fit): Promise<string> {
  if (!SOURCE_IMAGE_TYPES.has(file.type)) throw new Error("Unsupported file type. Choose a PNG, JPEG, WebP, or GIF image.");
  if (file.size > MAX_SOURCE_IMAGE_BYTES) throw new Error("This image is larger than 10 MiB. Choose a smaller file.");
  // Reject absurd canvases from the header alone: createImageBitmap would decode the whole frame first.
  const dimensions = await readImageDimensions(file).catch(() => null);
  if (dimensions && (dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > MAX_SOURCE_PIXELS)) throw new Error("Choose an image with 25 megapixels or less.");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("This image could not be opened. Choose another file."); }
  try {
    if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) throw new Error("Choose an image with 25 megapixels or less.");
    const canvas = document.createElement("canvas");
    canvas.width = THUMBNAIL_SIZE;
    canvas.height = THUMBNAIL_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser could not prepare this image.");
    context.imageSmoothingQuality = "high";
    const scale = fit === "cover" ? Math.max(THUMBNAIL_SIZE / bitmap.width, THUMBNAIL_SIZE / bitmap.height) : Math.min(THUMBNAIL_SIZE / bitmap.width, THUMBNAIL_SIZE / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    context.drawImage(bitmap, (THUMBNAIL_SIZE - w) / 2, (THUMBNAIL_SIZE - h) / 2, w, h);
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
      if (!blob || blob.type !== "image/webp") throw new Error("This browser cannot prepare WebP images.");
      if (blob.size <= MAX_THUMBNAIL_BYTES) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return `${EMBEDDED_PREFIX}${btoa(binary)}`;
      }
    }
    throw new Error("This image is too detailed to fit the 32 KiB limit. Try a simpler image.");
  } finally {
    bitmap.close();
  }
}

/** Arrow-key movement inside a role="radiogroup" of role="radio" buttons: focus the neighbour and select it. */
function onRadioKey(event: KeyboardEvent<HTMLElement>) {
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (!step) return;
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)'));
  const index = radios.indexOf(document.activeElement as HTMLElement);
  if (index < 0 || !radios.length) return;
  event.preventDefault();
  const next = radios[(index + step + radios.length) % radios.length];
  next.focus();
  next.click();
}

export type ProjectImageChoice = { imageUrl: string | null; iconName: string | null; iconColor: string | null; error: string | null; busy: boolean };
export type ProjectAppearance = { imageUrl: string | null; iconName: string | null; iconColor: string | null };

/**
 * Chooser for a project's single `imageUrl`: a catalog icon (with tint) or an uploaded / linked image.
 * Mount it fresh per project (use `key`); it reports the resulting value through `onChange`.
 */
export function ProjectImageChooser({ initial, projectName, labelledBy, disabled, onChange }: {
  initial: ProjectAppearance;
  projectName: string;
  labelledBy?: string;
  disabled?: boolean;
  onChange: (choice: ProjectImageChoice) => void;
}) {
  const initialValue = initial.imageUrl;
  const initialIcon = initial.iconName;
  const initialEmbedded = initialValue?.startsWith(EMBEDDED_PREFIX) ? initialValue : null;
  const [tab, setTab] = useState<"icons" | "image">(initialValue && !initialIcon ? "image" : "icons");
  const [iconName, setIconName] = useState<string | null>(initialIcon);
  const [iconColor, setIconColor] = useState<string | null>(initialIcon ? initial.iconColor : null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All");
  const [source, setSource] = useState<ImageSource>(initialValue && !initialIcon && !initialEmbedded ? "url" : "file");
  const [urlText, setUrlText] = useState(initialValue && !initialIcon && !initialEmbedded ? initialValue : "");
  const [file, setFile] = useState<File | null>(null);
  const [fit, setFit] = useState<Fit>("cover");
  const [thumb, setThumb] = useState<string | null>(initialEmbedded);
  const [thumbLabel, setThumbLabel] = useState(initialEmbedded ? "Current project image" : "");
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // The most recently edited kind decides the saved value, regardless of which tab is showing.
  const [active, setActive] = useState<"icon" | "image" | "none">(initialIcon ? "icon" : initialValue ? "image" : "none");

  const urlResult = useMemo(() => {
    const trimmed = urlText.trim();
    if (!trimmed) return { value: null as string | null, error: null as string | null };
    const value = source === "favicon" ? projectFaviconUrl(trimmed) : normalizeProjectImageUrl(trimmed);
    return value ? { value, error: null } : { value: null, error: "Enter a valid HTTP or HTTPS URL without credentials." };
  }, [source, urlText]);

  const choice = useMemo<ProjectImageChoice>(() => {
    const none = { imageUrl: null, iconName: null, iconColor: null };
    if (active === "none") return { ...none, error: null, busy: false };
    if (active === "icon" && iconName) return { ...none, iconName, iconColor, error: null, busy: false };
    if (source === "file") return { ...none, imageUrl: thumb, error: fileError, busy };
    return { ...none, imageUrl: urlResult.value, error: urlResult.error, busy: false };
  }, [active, busy, fileError, iconColor, iconName, source, thumb, urlResult]);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => { onChangeRef.current(choice); }, [choice]);

  const dropRef = useRef<HTMLDivElement>(null);
  const acceptNativeDropRef = useRef<(paths: string[]) => Promise<void>>(async () => undefined);
  // Tauri swallows DOM file drops and only reports paths for the whole window. Track the pointer so the zone still
  // reacts, and on drop read the bytes natively with the `read_dropped_image` command (see acceptNativeDropRef).
  const readingRef = useRef(false);
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "leave") { setDragging(false); return; }
      const rect = dropRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const x = payload.position.x / window.devicePixelRatio;
      const y = payload.position.y / window.devicePixelRatio;
      const over = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (payload.type === "drop") {
        setDragging(false);
        if (over) void acceptNativeDropRef.current(payload.paths);
        return;
      }
      setDragging(over);
    }).then((unlisten) => { if (disposed) unlisten(); else off = unlisten; }).catch(() => undefined);
    return () => { disposed = true; off?.(); };
  }, []);

  const renderThumb = useCallback(async (next: File, nextFit: Fit) => {
    setBusy(true);
    try {
      const data = await projectImageThumbnail(next, nextFit);
      setThumb(data);
      setThumbLabel(next.name);
      setFileError(null);
    } catch (error) {
      setFileError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, []);

  function acceptFile(next: File | undefined) {
    if (!next) return;
    setFile(next);
    setActive("image");
    void renderThumb(next, fit);
  }

  acceptNativeDropRef.current = async (paths: string[]) => {
    if (disabled || busy || readingRef.current) return;
    if (paths.length !== 1) { setFileError("Drop a single image file."); return; }
    const path = paths[0];
    readingRef.current = true;
    setBusy(true);
    try {
      const bytes = await invoke<ArrayBuffer>("read_dropped_image", { path });
      const name = path.split(/[\\/]/).pop() || "image";
      const head = new Uint8Array(bytes.slice(0, 4));
      const type = head[0] === 0x89 ? "image/png" : head[0] === 0xff ? "image/jpeg" : head[0] === 0x47 ? "image/gif" : "image/webp";
      acceptFile(new File([bytes], name, { type }));
    } catch (error) {
      setFileError(errorMessage(error));
      setBusy(false);
    } finally {
      readingRef.current = false;
    }
  };

  function changeFit(next: Fit) {
    setFit(next);
    if (file) void renderThumb(file, next);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled || busy) return;
    const dropped = event.dataTransfer.files;
    if (dropped.length > 1) setFileError("Drop a single image file.");
    else acceptFile(dropped[0]);
  }

  function resetAll() {
    setIconName(null);
    setIconColor(null);
    setFile(null);
    setThumb(null);
    setThumbLabel("");
    setFileError(null);
    setUrlText("");
    setActive("none");
  }

  const q = query.trim().toLowerCase();
  const visibleIcons = useMemo(() => PROJECT_ICONS.filter((entry) =>
    (category === "All" || entry.category === category) && (!q || entry.label.toLowerCase().includes(q) || entry.name.includes(q) || entry.category.toLowerCase().includes(q))), [category, q]);

  function onGridKey(event: KeyboardEvent<HTMLDivElement>) {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 0, ArrowUp: 0, Home: 0, End: 0 };
    if (!(event.key in keys)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-icon]"));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const columns = Math.max(1, getComputedStyle(event.currentTarget).gridTemplateColumns.split(" ").length);
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") next = index + keys[event.key];
    else if (event.key === "ArrowDown") next = index + columns;
    else if (event.key === "ArrowUp") next = index - columns;
    else if (event.key === "Home") next = 0;
    else next = items.length - 1;
    if (next < 0 || next >= items.length) return;
    event.preventDefault();
    items[next].focus();
  }

  const previewProject = { imageUrl: choice.imageUrl, iconName: choice.iconName, iconColor: choice.iconColor, gitUrl: null };
  const hasValue = !!(choice.imageUrl || choice.iconName);
  const focusableIcon = iconName && visibleIcons.some((entry) => entry.name === iconName) ? iconName : visibleIcons[0]?.name;

  return <div role="group" aria-labelledby={labelledBy} className="flex flex-col gap-3">
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-background ring-1 ring-foreground/10" aria-hidden>
        {hasValue ? <ProjectMark key={`${choice.iconName}${choice.iconColor}${choice.imageUrl}`} project={previewProject} className="size-8 rounded-lg" /> : <IconBox className="size-6 text-muted-foreground" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{projectName || "Project"}</p>
        <p className="text-xs text-muted-foreground" aria-live="polite">{busy ? "Preparing image…" : choice.iconName ? "Built-in icon" : choice.imageUrl ? "Custom image" : "Default icon"}</p>
      </div>
      <Button type="button" variant="ghost" size="sm" disabled={disabled || (!hasValue && !initialValue && !initialIcon)} onClick={resetAll}><IconTrash data-icon="inline-start" />Reset</Button>
    </div>

    <Tabs value={tab} onValueChange={(value) => {
      // A URL/file error belongs to the Image tab; do not let it silently block Save from the Icons tab.
      if (value === "icons" && active === "image" && choice.error) setActive(iconName ? "icon" : "none");
      setTab(value as "icons" | "image");
    }}>
      <TabsList className="w-full"><TabsTrigger value="icons">Icons</TabsTrigger><TabsTrigger value="image">Image</TabsTrigger></TabsList>

      <TabsContent value="icons" className="flex flex-col gap-3">
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search icons" placeholder="Search icons" className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Icon categories">
          {["All", ...PROJECT_ICON_CATEGORIES].map((name) => <Button key={name} type="button" size="sm" variant={category === name ? "secondary" : "ghost"} aria-pressed={category === name} className="h-7 px-2.5 text-xs" onClick={() => setCategory(name)}>{name}</Button>)}
        </div>
        <div ref={gridRef} role="radiogroup" aria-label="Project icon" onKeyDown={onGridKey} className="grid max-h-56 grid-cols-6 gap-1 overflow-y-auto rounded-md border border-border p-1.5 sm:grid-cols-8">
          {visibleIcons.map(({ name, label, Icon }) => {
            const selected = iconName === name;
            return <button key={name} type="button" role="radio" aria-checked={selected} aria-label={label} title={label} data-icon={name} tabIndex={name === focusableIcon ? 0 : -1} disabled={disabled}
              onClick={() => { setIconName(name); setActive("icon"); }}
              className={cn("flex aspect-square items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", selected && "bg-primary/10 text-foreground ring-2 ring-primary")}>
              <Icon className="size-5" style={selected && iconColor ? { color: iconColor } : undefined} />
            </button>;
          })}
          {visibleIcons.length === 0 && <p className="col-span-full py-6 text-center text-sm text-muted-foreground">No icons match “{query}”.</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label id="project-icon-color-label">Color</Label>
          <div role="radiogroup" aria-labelledby="project-icon-color-label" onKeyDown={onRadioKey} className="flex flex-wrap items-center gap-1.5">
            {ICON_COLORS.map(({ value, label }) => {
              const selected = iconColor === value;
              return <button key={label} type="button" role="radio" aria-checked={selected} aria-label={label} title={label} disabled={disabled} tabIndex={selected || (iconColor === null && value === null) ? 0 : -1}
                onClick={() => { setIconColor(value); setActive("icon"); if (!iconName) setIconName("box"); }}
                className={cn("flex size-6 items-center justify-center rounded-full border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring", selected && "ring-2 ring-primary ring-offset-2 ring-offset-background")}
                style={value ? { backgroundColor: value } : undefined}>
                {!value && <IconX className="size-3 text-muted-foreground" />}
              </button>;
            })}
          </div>
        </div>
      </TabsContent>

      <TabsContent value="image" className="flex flex-col gap-3">
        <div role="radiogroup" aria-label="Image source" onKeyDown={onRadioKey} className="flex flex-wrap gap-1">
          {([["file", "Upload"], ["url", "Image URL"], ["favicon", "Website favicon"]] as const).map(([id, label]) =>
            <Button key={id} type="button" size="sm" variant={source === id ? "secondary" : "ghost"} role="radio" aria-checked={source === id} tabIndex={source === id ? 0 : -1} className="h-7 px-2.5 text-xs" onClick={() => { setSource(id); setActive("image"); }}>{label}</Button>)}
        </div>
        {source === "file" ? <>
          <div
            ref={dropRef}
            onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn("flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border p-5 text-center transition-colors", dragging && "border-primary bg-primary/5")}>
            {thumb ? <img src={thumb} alt="Selected project image preview" className="size-20 rounded-xl bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:12px_12px] object-cover ring-1 ring-foreground/10" /> : <IconPhotoUp className="size-8 text-muted-foreground" />}
            <p className="text-sm">{thumb ? <span className="break-all">{thumbLabel}</span> : "Drag an image here, or"}</p>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={disabled || busy} onClick={() => inputRef.current?.click()}>{thumb ? "Replace…" : "Browse files…"}</Button>
              {thumb && <Button type="button" size="sm" variant="ghost" disabled={disabled || busy} onClick={() => { setThumb(null); setFile(null); setThumbLabel(""); setFileError(null); }}><IconTrash data-icon="inline-start" />Remove</Button>}
            </div>
            <input ref={inputRef} type="file" className="sr-only" tabIndex={-1} aria-label="Choose image file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const picked = event.currentTarget.files?.[0]; event.currentTarget.value = ""; acceptFile(picked); }} />
            <p className="text-xs text-muted-foreground">PNG, JPEG, WebP or GIF up to 10 MiB. Cropped to a 128 × 128 square.</p>
          </div>
          <div role="radiogroup" aria-label="Square fit" onKeyDown={onRadioKey} className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="mr-1">Fit</span>
            {([["cover", "Crop to fill"], ["contain", "Fit inside"]] as const).map(([id, label]) =>
              <Button key={id} type="button" size="sm" variant={fit === id ? "secondary" : "ghost"} role="radio" aria-checked={fit === id} tabIndex={fit === id ? 0 : -1} disabled={disabled || busy} className="h-7 px-2.5 text-xs" onClick={() => changeFit(id)}>{label}</Button>)}
          </div>
        </> : <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-image-url">{source === "url" ? "Image URL" : "Website URL"}</Label>
          <Input id="project-image-url" inputMode="url" aria-invalid={!!urlResult.error} placeholder={source === "url" ? "https://example.com/project.png" : "https://example.com"} value={urlText} disabled={disabled} onChange={(event) => { setUrlText(event.target.value); setActive("image"); }} />
          <p className="text-xs text-muted-foreground">Loaded directly in your browser. Must use HTTP or HTTPS.</p>
        </div>}
        {choice.error && tab === "image" && <p role="alert" className="text-sm text-destructive">{choice.error}</p>}
      </TabsContent>
    </Tabs>
  </div>;
}
