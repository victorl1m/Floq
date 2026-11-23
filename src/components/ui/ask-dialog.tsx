import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Promise-based replacement for window.confirm / window.prompt: those render as a native
 * "tauri.localhost says" box that ignores the theme. Call askConfirm / askText from anywhere
 * (components or plain modules); <AskDialogHost /> at the app root renders one request at a time.
 */

type ConfirmRequest = {
  kind: "confirm";
  title: string;
  description?: ReactNode;
  actionLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Enter runs the action (the action button is focused on open) instead of Cancel. For safe confirms that follow an
   * Enter the user already pressed, e.g. "Wake and send". Never for destructive ones. */
  enterConfirms?: boolean;
  resolve: (value: boolean) => void;
};

type TextRequest = {
  kind: "text";
  title: string;
  description?: ReactNode;
  label: string;
  placeholder?: string;
  initial?: string;
  actionLabel?: string;
  cancelLabel?: string;
  /** Returns an error message for invalid input, or null when it is fine. */
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
};

type AskRequest = ConfirmRequest | TextRequest;

const queue: AskRequest[] = [];
const listeners = new Set<() => void>();
const notify = () => { for (const fn of listeners) fn(); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const current = () => queue[0] ?? null;
let mounted = 0;

function settle(request: AskRequest, value: boolean | string | null) {
  const index = queue.indexOf(request);
  if (index >= 0) queue.splice(index, 1);
  if (request.kind === "confirm") request.resolve(value === true);
  else request.resolve(typeof value === "string" ? value : null);
  notify();
}

/** Resolves true on the action button, false on Cancel, Escape or dismiss. */
export function askConfirm(options: Omit<ConfirmRequest, "kind" | "resolve">): Promise<boolean> {
  // Without a host (e.g. a test or an isolated view) fall back to the native dialog rather than hang.
  if (!mounted) return Promise.resolve(window.confirm(options.title));
  return new Promise((resolve) => { queue.push({ ...options, kind: "confirm", resolve }); notify(); });
}

/** Resolves the entered text (trimmed) on submit, null on Cancel, Escape or dismiss. */
export function askText(options: Omit<TextRequest, "kind" | "resolve">): Promise<string | null> {
  if (!mounted) return Promise.resolve(window.prompt(options.label, options.initial ?? ""));
  return new Promise((resolve) => { queue.push({ ...options, kind: "text", resolve }); notify(); });
}

export function AskDialogHost() {
  const request = useSyncExternalStore(subscribe, current, current);
  useEffect(() => {
    mounted++;
    return () => { mounted--; };
  }, []);
  return request ? <AskDialog key={queue.length + request.title} request={request} /> : null;
}

function AskDialog({ request }: { request: AskRequest }) {
  const inputId = useId();
  const [value, setValue] = useState(request.kind === "text" ? request.initial ?? "" : "");
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const actionRef = useRef<HTMLButtonElement>(null);
  const enterConfirms = request.kind === "confirm" && request.enterConfirms === true && !request.destructive;
  const finish = (result: boolean | string | null) => {
    if (done.current) return;
    done.current = true;
    settle(request, result);
  };
  const submit = () => {
    if (request.kind === "confirm") return finish(true);
    const text = value.trim();
    const problem = request.validate?.(text) ?? (text ? null : "Enter a value.");
    if (problem) { setError(problem); return; }
    finish(text);
  };

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) finish(request.kind === "confirm" ? false : null); }}>
      <AlertDialogContent
        onOpenAutoFocus={enterConfirms ? (event) => { event.preventDefault(); actionRef.current?.focus(); } : undefined}
        onKeyDown={enterConfirms ? (event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !event.repeat) { event.preventDefault(); submit(); } } : undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
          {request.description && <AlertDialogDescription asChild><div>{request.description}</div></AlertDialogDescription>}
        </AlertDialogHeader>
        {request.kind === "text" && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={inputId} className="text-sm font-medium">{request.label}</label>
            <Input
              id={inputId}
              autoFocus
              value={value}
              placeholder={request.placeholder}
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? inputId + "-error" : undefined}
              onChange={(event) => { setValue(event.target.value); setError(null); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }}
            />
            {error && <p id={inputId + "-error"} role="alert" className="text-xs text-destructive">{error}</p>}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => finish(request.kind === "confirm" ? false : null)}>{request.cancelLabel ?? "Cancel"}</AlertDialogCancel>
          <Button ref={actionRef} variant={request.kind === "confirm" && request.destructive ? "destructive" : "default"} onClick={submit}>
            {request.actionLabel ?? (request.kind === "confirm" ? "Continue" : "Save")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
