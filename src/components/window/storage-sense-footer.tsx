import { useCallback, useState } from "react";
import { IconTrash } from "@tabler/icons-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePlugins } from "@/plugins/host";
import { isActive } from "@/plugins/registry";
import { StorageSensePanel, size, type StorageSenseState } from "@/plugins/storage-sense";

const ID = "storage-sense";

/** Footer button right of memory usage: free space at a glance, the last cleanup report in a popover. Hidden when the plugin is off. */
export function StorageSenseFooterButton() {
  const plugin = usePlugins().all.find((p) => p.id === ID);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<StorageSenseState | null>(null);
  const onState = useCallback((next: StorageSenseState) => setState(next), []);
  if (!plugin || !isActive(plugin)) return null;
  const freed = state?.report && !state.report.dryRun ? size(state.report.freedBytes) : "";
  const attention = state?.report?.counts.attention ?? 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" type="button" title="Storage Sense" aria-label="Show Storage Sense"
          className={cn("gap-1.5 px-2 text-[11px] text-muted-foreground tabular-nums", open && "bg-muted text-foreground")}>
          <IconTrash size={12} stroke={1.5} />
          <span>{state?.freePercent != null ? `${state.freePercent}% free` : freed || "Storage"}</span>
          {attention > 0 && <span className="size-1.5 rounded-full bg-destructive" aria-label={`${attention} item(s) need attention`} />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-[420px] p-0">
        <ScrollArea className="max-h-[60vh]"><div className="p-3"><StorageSensePanel pluginId={ID} onState={onState} /></div></ScrollArea>
      </PopoverContent>
      {/* Loads the state once while closed, so the button can show free space. */}
      {!open && !state && <span hidden><StorageSensePanel pluginId={ID} onState={onState} /></span>}
    </Popover>
  );
}
