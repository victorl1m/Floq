import { useCallback, useEffect, useState } from "react";
import { IconAlertTriangle, IconKey, IconPlus, IconRefresh } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { SecretInfo } from "@/lib/runtime/types";

/** Fired by the Secrets page after a global secret is created, edited or deleted. */
export const VAULT_CHANGED_EVENT = "floq:vault-changed";

/**
 * Canvas topbar chip for the global vault. Global secrets reach every agent without wires; this lists
 * them by name only (values are write-only and never fetched) and refreshes when the Secrets page changes them.
 */
export default function VaultPopover({ size = "default" }: { size?: "default" | "sm" } = {}) {
  const { client, navigate } = useRuntime();
  const [secrets, setSecrets] = useState<SecretInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    setError(null);
    try { setSecrets(await client.secrets()); }
    catch (e) { setError(errorMessage(e)); }
  }, [client]);

  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener(VAULT_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(VAULT_CHANGED_EVENT, onChange);
  }, [load]);

  const count = secrets?.length ?? 0;
  const label = secrets === null ? (error ? "Global vault, failed to load" : "Global vault, loading") : `Global vault, ${count} ${count === 1 ? "secret" : "secrets"}`;

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) void load(); }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size={size} className="shrink-0 gap-1.5 pr-1.5 text-foreground dark:bg-transparent dark:hover:bg-transparent" aria-label={label}>
              <IconKey size={15} className="text-amber-600 dark:text-amber-400" aria-hidden="true" />
              Vault
              {secrets !== null && <span className={`min-w-5 rounded-full border border-foreground/15 bg-foreground/10 px-1.5 text-center text-[11px] ${size === "sm" ? "leading-4" : "leading-[18px]"} font-medium text-foreground tabular-nums`}>{count}</span>}
              {error && secrets === null && <IconAlertTriangle size={14} className="text-destructive" />}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Global vault: available to all agents, no wires needed</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 gap-0 p-0" aria-label="Global secrets">
        <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">Global secrets</p>
            <p className="text-xs text-muted-foreground">Available to every agent. Values stay hidden.</p>
          </div>
          <span className="rounded-full border border-border/70 bg-muted/55 px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">{count}</span>
        </div>
        {secrets === null && !error ? (
          <div role="status" aria-label="Loading global secrets" className="space-y-2 p-3">
            {[0, 1].map((i) => <div key={i} className="h-8 animate-pulse rounded-lg bg-muted/60 motion-reduce:animate-none" />)}
            <span className="sr-only">Loading global secrets…</span>
          </div>
        ) : error && secrets === null ? (
          <div role="alert" className="flex flex-col items-start gap-2 p-3 text-xs">
            <p className="text-destructive">Could not load secrets: {error}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}><IconRefresh size={14} />Try again</Button>
          </div>
        ) : count === 0 ? (
          <div className="flex flex-col items-start gap-2 p-3">
            <p className="text-xs text-muted-foreground">No global secrets yet. Add one when every agent needs the same credential.</p>
            <Button type="button" size="sm" onClick={() => { setOpen(false); navigate("secrets"); }}><IconPlus size={14} />Create a secret</Button>
          </div>
        ) : (
          <>
            <ul aria-label="Global secrets" className="max-h-64 divide-y divide-border/60 overflow-y-auto">
              {secrets!.map((s) => (
                <li key={s.name} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs font-medium" title={s.name}>{s.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground" aria-hidden="true">••••••••</p>
                    <span className="sr-only">Value hidden</span>
                  </div>
                  <span className="shrink-0 rounded-full border border-border/70 bg-muted/55 px-1.5 py-0.5 text-[10px] text-muted-foreground">Global</span>
                </li>
              ))}
            </ul>
            <div className="border-t border-border/70 p-1.5">
              <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={() => { setOpen(false); navigate("secrets"); }}>Manage in Secrets</Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
