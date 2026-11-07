import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Keys } from "./canvas-kbd";

export function ShortcutTip({ label, keys, children }: { label: string; keys?: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}{keys && <Keys keys={keys} className="ml-2 pl-0" />}</TooltipContent>
    </Tooltip>
  );
}
