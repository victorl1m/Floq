import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { PluginSettingDecl, PluginSettingValues } from "@/lib/runtime/types";
import { draftToValues, initialDraft, isDirty, type Draft } from "@/plugins/settings-form";

/**
 * The declarative settings renderer: one field per `manifest.settings` entry (text, url, number, boolean, select, secretRef).
 * Entered values are kept when a save fails; validation messages name the field and never echo the value.
 */
export function PluginSettingsForm({ pluginId, decls, values, disabled, onSave }: {
  pluginId: string;
  decls: PluginSettingDecl[];
  values: PluginSettingValues;
  disabled?: boolean;
  /** Throw to report a failure: the message is shown under the form and the draft is kept. */
  onSave: (values: PluginSettingValues) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(decls, values));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState("");
  const [saving, setSaving] = useState(false);
  // New saved values from outside (a reload) reset the draft; edits in progress are not clobbered by re-renders.
  const savedKey = JSON.stringify(values);
  useEffect(() => { setDraft(initialDraft(decls, values)); setErrors({}); setFailure(""); }, [savedKey, decls]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (key: string, value: string) => { setDraft((d) => ({ ...d, [key]: value })); setErrors((e) => { if (!e[key]) return e; const { [key]: _gone, ...rest } = e; return rest; }); };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = draftToValues(decls, draft);
    setErrors(result.errors);
    if (Object.keys(result.errors).length) return;
    setSaving(true); setFailure("");
    try { await onSave(result.values); } catch (error) { setFailure(error instanceof Error ? error.message : "Could not save."); } finally { setSaving(false); }
  }

  if (!decls.length) return <p className="text-sm text-muted-foreground">This plugin has no settings.</p>;
  return (
    <form onSubmit={submit} noValidate data-slot="plugin-settings-form" className="space-y-4">
      <FieldGroup>
        {decls.map((d) => {
          const id = `plugin-${pluginId}-${d.key}`;
          const error = errors[d.key];
          return (
            <Field key={d.key} data-invalid={error ? "true" : undefined}>
              {d.type === "boolean" ? (
                <div className="flex items-center justify-between gap-3">
                  <FieldLabel htmlFor={id}>{d.label}</FieldLabel>
                  <Switch id={id} checked={draft[d.key] === "true"} disabled={disabled} onCheckedChange={(on) => set(d.key, String(on))} />
                </div>
              ) : (
                <>
                  <FieldLabel htmlFor={id}>{d.label}{d.required && <span aria-hidden="true" className="text-muted-foreground"> *</span>}</FieldLabel>
                  {d.type === "select" ? (
                    <Select value={draft[d.key] || undefined} onValueChange={(v) => set(d.key, v)} disabled={disabled}>
                      <SelectTrigger id={id} className="w-full" aria-invalid={error ? true : undefined}><SelectValue placeholder="Choose…" /></SelectTrigger>
                      <SelectContent>{(d.options ?? []).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={id} value={draft[d.key] ?? ""} disabled={disabled} aria-invalid={error ? true : undefined}
                      type={d.type === "number" ? "number" : d.type === "url" ? "url" : "text"}
                      inputMode={d.type === "number" ? "decimal" : undefined}
                      placeholder={d.type === "secretRef" ? "MY_SECRET" : d.type === "url" ? "https://" : undefined}
                      className={d.type === "secretRef" ? "font-mono" : undefined}
                      autoComplete="off" spellCheck={false}
                      onChange={(e) => set(d.key, e.target.value)}
                    />
                  )}
                </>
              )}
              {d.description && <FieldDescription>{d.description}{d.type === "secretRef" && " Enter the name of a secret from Secrets, never its value."}</FieldDescription>}
              {!d.description && d.type === "secretRef" && <FieldDescription>Enter the name of a secret from Secrets, never its value.</FieldDescription>}
              {error && <FieldError>{error}</FieldError>}
            </Field>
          );
        })}
      </FieldGroup>
      {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
      <Button type="submit" size="sm" disabled={disabled || saving || !isDirty(decls, draft, values)}>{saving ? "Saving…" : "Save settings"}</Button>
    </form>
  );
}
