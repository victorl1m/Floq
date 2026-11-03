import { Kbd } from "@/components/ui/kbd";
import { cn } from "cn";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const LABEL: Record<string, string> = { Del: "Del", Esc: "Esc" };

/** Shortcut hint as separate key chips ("Ctrl A" -> [Ctrl][A]), pinned to the right edge of a menu row or tooltip. */
export function Keys({ keys, className, inset }: { keys: string; className?: string; inset?: boolean }) {
  const parts = keys.split(/\s+/).filter(Boolean).map((key) => (key === "Ctrl" && isMac() ? "⌘" : LABEL[key] ?? key));
  return (
    <span className={cn("ml-auto flex shrink-0 items-center gap-0.5 pl-3", inset && "mr-[26px]", className)} aria-hidden="true">
      {parts.map((key, index) => <Kbd key={index} className="h-5 min-w-5 rounded border bg-muted px-1.5 text-[10px]">{key}</Kbd>)}
    </span>
  );
}
