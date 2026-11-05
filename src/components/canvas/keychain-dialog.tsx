import { useRef, useState } from "react";
import { IconCheck, IconCopy, IconEye, IconEyeOff, IconFileImport, IconInfoCircle, IconLock, IconPencil, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { copyText } from "@/lib/clipboard";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";
import { deleteKeychainSecret, setKeychainSecret } from "./canvas-data";

const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const getCommand = (name: string) => `floq secret get ${name}`;

/** Parses pasted .env text: comments, `export`, quotes and trailing comments handled. Values stay in memory only until saved. */
export function parseEnv(text: string): { name: string; value: string }[] {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      const end = value.lastIndexOf(quote);
      value = value.slice(1, end);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out.set(match[1].toUpperCase(), value);
  }
  return [...out].map(([name, value]) => ({ name, value }));
}

export interface KeychainLike { id: string; name: string; secretNames: string[] }
interface Props {
  keychain: KeychainLike;
  client: RuntimeClient | null;
  onClose: () => void;
  /** Re-reads the keychain after a change; the parent then passes the fresh secretNames back in. */
  onChanged: () => Promise<void>;
}

/** The wallet of one keychain. Values are write-only: never fetched, never persisted, cleared on save and close. */
export default function KeychainDialog({ keychain, client, onClose, onChanged }: Props) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastName, setLastName] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const [envText, setEnvText] = useState("");
  const valueRef = useRef<HTMLTextAreaElement>(null);

  const nameValid = NAME_RE.test(name);
  const reset = () => { setName(""); setValue(""); setEnvText(""); setShow(false); };

  async function save() {
    if (!client || !nameValid || !value || saving) return;
    setSaving(true);
    setError(null);
    try {
      await setKeychainSecret(client, keychain.id, name, value);
      setLastName(name);
      toast.success(`Secret ${name} saved`, { description: "The value is stored in this keychain." });
      reset();
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const parsed = bulk ? parseEnv(envText) : [];
  const validParsed = parsed.filter((item) => NAME_RE.test(item.name) && item.value !== "");
  async function importAll() {
    if (!client || validParsed.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    let ok = 0;
    const failed: string[] = [];
    for (const item of validParsed) {
      try { await setKeychainSecret(client, keychain.id, item.name, item.value); ok += 1; }
      catch (err) { failed.push(`${item.name}: ${errorMessage(err)}`); }
    }
    setSaving(false);
    setEnvText("");
    if (ok) { setLastName(validParsed[0].name); toast.success(`${ok} secret${ok === 1 ? "" : "s"} saved`, { description: "The values are stored in this keychain." }); }
    if (failed.length) setError(failed.join("\n"));
    else setBulk(false);
    await onChanged();
  }

  async function remove(secretName: string) {
    if (!client) return;
    setDeleting(secretName);
    try {
      await deleteKeychainSecret(client, keychain.id, secretName);
      setConfirming(null);
      await onChanged();
    } catch (err) {
      toast.error("Could not delete the secret", { description: errorMessage(err) });
    } finally {
      setDeleting(null);
    }
  }

  const command = getCommand(lastName ?? keychain.secretNames[0] ?? "NAME");
  const copy = () => void copyText(command).then(() => toast.success("Command copied", { description: "It is on your clipboard." }), (err) => toast.error("Could not copy the command", { description: errorMessage(err) }));

  return (
    <Dialog open onOpenChange={(open) => { if (!open) { reset(); onClose(); } }}>
      <DialogContent className="max-h-[88vh] gap-3 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2"><IconLock size={16} className="shrink-0 text-amber-500" /><span className="truncate">Keychain — {keychain.name}</span></DialogTitle>
          <DialogDescription className="flex items-start gap-1.5 text-xs">
            <IconInfoCircle size={14} className="mt-px shrink-0" />
            Encrypted at rest. Every agent linked to this keychain receives these as environment variables when it starts or wakes; running agents can read them with the command below.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs">
          {lastName && <IconCheck size={14} className="shrink-0 text-emerald-500" />}
          <code className="min-w-0 flex-1 truncate font-mono">{command}</code>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Copy command" title="Copy command" onClick={copy}><IconCopy size={13} /></Button>
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium text-muted-foreground uppercase">Secrets · {keychain.secretNames.length}</div>
          {keychain.secretNames.length === 0 ? (
            <div className="rounded-md border border-dashed py-3 text-center text-xs text-muted-foreground">No secrets in this keychain yet.</div>
          ) : (
            <ul className="flex flex-col divide-y rounded-md border">
              {keychain.secretNames.map((secretName) => (
                <li key={secretName} className="flex items-center gap-2 px-2 py-1.5">
                  <div className="min-w-0 flex-1 truncate font-mono text-xs" title={secretName}>{secretName}</div>
                  {confirming === secretName ? (
                    <>
                      <Button type="button" size="xs" variant="destructive" disabled={deleting === secretName} onClick={() => void remove(secretName)}>{deleting === secretName ? <Spinner /> : "Delete"}</Button>
                      <Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
                    </>
                  ) : (
                    <>
                      <Button type="button" size="xs" variant="ghost" onClick={() => { setBulk(false); setName(secretName); setValue(""); setError(null); setTimeout(() => valueRef.current?.focus(), 0); }}><IconPencil size={12} />Replace</Button>
                      <Button type="button" size="icon-xs" variant="ghost" aria-label={`Delete ${secretName}`} title="Delete" onClick={() => setConfirming(secretName)}><IconTrash size={13} /></Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2 rounded-md border p-2.5">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-medium text-muted-foreground uppercase">{bulk ? "Paste .env" : "Add secret"}</div>
            <Button type="button" size="xs" variant="ghost" onClick={() => { setBulk((v) => !v); setError(null); }}><IconFileImport size={12} />{bulk ? "Single secret" : "Paste .env"}</Button>
          </div>
          {bulk ? (
            <>
              <Textarea aria-label="Secrets in environment file format" value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={"API_KEY=…\nDB_URL=\"…\""} rows={5} spellCheck={false} autoComplete="off" className="font-mono text-xs [-webkit-text-security:disc]" />
              {parsed.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {parsed.map((item) => {
                    const good = NAME_RE.test(item.name) && item.value !== "";
                    return <span key={item.name} className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${good ? "" : "border-destructive/50 text-destructive"}`} title={good ? "Value hidden" : "Invalid name or empty value"}>{item.name}</span>;
                  })}
                </div>
              )}
              <Button type="button" size="sm" className="self-end" disabled={saving || validParsed.length === 0} onClick={() => void importAll()}>
                {saving && <Spinner />}Save {validParsed.length || ""} secret{validParsed.length === 1 ? "" : "s"}
              </Button>
            </>
          ) : (
            <form noValidate className="flex flex-col gap-2" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <Input aria-label="Secret name" value={name} onChange={(event) => { setName(event.target.value.toUpperCase().replace(/\s+/g, "_")); setError(null); }} placeholder="NAME" maxLength={64} spellCheck={false} autoComplete="off" aria-invalid={name !== "" && !nameValid} className="font-mono text-xs" />
              {name !== "" && !nameValid && <p className="text-[11px] text-destructive">Use A-Z, 0-9 and _, not starting with a digit (max 64).</p>}
              <div className="relative">
                <Textarea aria-label="Secret value" ref={valueRef} value={value} onChange={(event) => { setValue(event.target.value); setError(null); }} placeholder="Value" rows={2} spellCheck={false} autoComplete="off" data-1p-ignore data-lpignore="true" className={`pr-9 font-mono text-xs ${show ? "" : "[-webkit-text-security:disc]"}`} />
                <Button type="button" variant="ghost" size="icon-xs" className="absolute top-1 right-1" aria-label={show ? "Hide value" : "Show value"} title={show ? "Hide value" : "Show value"} onClick={() => setShow((v) => !v)}>
                  {show ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                </Button>
              </div>
              <Button type="submit" size="sm" className="self-end" disabled={saving || !nameValid || !value} aria-busy={saving}>{saving && <Spinner />}Save</Button>
            </form>
          )}
          {error && <p className="text-[11px] whitespace-pre-wrap text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
