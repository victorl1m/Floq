import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RuntimeError } from "@/lib/runtime/client";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import {
  WEEKDAY_NAMES, browserTimezone, defaultScheduleForm, describeSchedule, formToSchedule, formatWhen, scheduleToForm, validateAutomationForm, validateScheduleForm,
  type CatchUp, type FormErrors, type ProjectAutomation, type RecurringFreq, type ScheduleForm,
} from "@/lib/project-tasks";

interface Props {
  open: boolean;
  onClose: () => void;
  automation: ProjectAutomation | null;
  projectId: string | null;
  projects: { id: string; label: string }[];
  onSaved: () => void;
}

const FREQ_UNIT: Record<RecurringFreq, string> = { daily: "day(s)", weekly: "week(s)", monthly: "month(s)", yearly: "year(s)" };

function Field({ label, id, error, hint, children }: { label: string; id: string; error?: string; hint?: string; children: ReactNode }) {
  return <div className="space-y-1.5"><Label htmlFor={id}>{label}</Label>{children}{hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}{error && <p id={`${id}-err`} role="alert" className="text-xs text-destructive">{error}</p>}</div>;
}

export default function AutomationEditor({ open, onClose, automation, projectId, projects, onSaved }: Props) {
  return <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
    <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">{open && <Form key={automation?.id ?? "new"} automation={automation} projectId={projectId} projects={projects} onClose={onClose} onSaved={onSaved} />}</DialogContent>
  </Dialog>;
}

function Form({ automation, projectId, projects, onClose, onSaved }: Omit<Props, "open">) {
  const { client } = useRuntime();
  const [title, setTitle] = useState(automation?.title ?? "");
  const [instructions, setInstructions] = useState(automation?.instructions ?? "");
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);
  const [catchUp, setCatchUp] = useState<CatchUp>(automation?.catchUp ?? "once");
  const [project, setProject] = useState(automation?.projectId ?? projectId ?? projects[0]?.id ?? "");
  const [form, setForm] = useState<ScheduleForm>(() => (automation ? scheduleToForm(automation.schedule) : defaultScheduleForm()));
  const [serverErrors, setServerErrors] = useState<FormErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [upcoming, setUpcoming] = useState<string[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const set = (patch: Partial<ScheduleForm>) => { setForm((f) => ({ ...f, ...patch })); setServerErrors({}); };

  const localErrors = useMemo(() => validateAutomationForm({ title, instructions, schedule: form }), [title, instructions, form]);
  const scheduleErrors = useMemo(() => validateScheduleForm(form), [form]);
  const errors = submitted ? { ...localErrors, ...serverErrors } : serverErrors;
  const valid = Object.keys(scheduleErrors).length === 0;
  const schedule = valid ? formToSchedule(form) : null;
  const sentence = schedule ? describeSchedule(schedule) : null;

  // Live "Next runs" from the server, so the preview matches what the scheduler will do.
  useEffect(() => {
    if (!client || !schedule) { setUpcoming(null); setPreviewError(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      client.previewSchedule(schedule).then((u) => { if (live) { setUpcoming(u); setPreviewError(null); } })
        .catch((e) => { if (live) { setUpcoming(null); setPreviewError(errorMessage(e)); } });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, JSON.stringify(schedule)]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(localErrors).length || !schedule || !client || !project) return;
    setSaving(true);
    try {
      const body = { title: title.replace(/\s+/g, " ").trim(), instructions, enabled, schedule, catchUp };
      if (automation) await client.updateAutomation(automation.projectId, automation.id, body);
      else await client.createAutomation(project, body);
      toast.success(automation ? "Automation saved" : "Automation created");
      onSaved(); onClose();
    } catch (err) {
      const field = err instanceof RuntimeError && typeof err.details?.field === "string" ? err.details.field : null;
      if (field) setServerErrors({ [field]: errorMessage(err) }); else toast.error(errorMessage(err));
    } finally { setSaving(false); }
  };

  const err = (k: string) => errors[k];
  const invalid = (k: string) => ({ "aria-invalid": !!err(k), "aria-describedby": err(k) ? `${k}-err` : undefined });
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <DialogHeader><DialogTitle>{automation ? "Edit automation" : "New automation"}</DialogTitle>
        <DialogDescription>Creates a task on a schedule. If “Agents work on tasks” is on for the project, the agent starts it right away.</DialogDescription></DialogHeader>
      {!automation && !projectId && <Field label="Project" id="auto-project"><NativeSelect id="auto-project" className="w-full" value={project} onChange={(e) => setProject(e.target.value)}>{projects.map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.label}</NativeSelectOption>)}</NativeSelect></Field>}
      <Field label="Name" id="title" error={err("title")}><Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Monthly report" {...invalid("title")} /></Field>
      <Field label="Instructions for the agent" id="instructions" error={err("instructions")}><Textarea id="instructions" rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="What should the agent do each time?" {...invalid("instructions")} /></Field>

      <fieldset className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-3">
        <legend className="px-1 text-sm font-medium">Schedule</legend>
        <div role="radiogroup" aria-label="Schedule type" className="inline-flex rounded-lg border p-0.5">
          {(["once", "repeat"] as const).map((m) => <button key={m} type="button" role="radio" aria-checked={form.mode === m} onClick={() => set({ mode: m })} className={`rounded-md px-3 py-1 text-sm ${form.mode === m ? "bg-muted font-medium" : "text-muted-foreground"}`}>{m === "once" ? "Once" : "Repeat"}</button>)}
        </div>
        {form.mode === "once" ? (
          <Field label="Date and time" id="schedule.at" error={err("schedule.at")}><Input id="schedule.at" type="datetime-local" value={form.onceAt} onChange={(e) => set({ onceAt: e.target.value })} {...invalid("schedule.at")} /></Field>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <span className="pb-2 text-sm">Every</span>
              <div className="w-20"><Label htmlFor="schedule.interval" className="sr-only">Interval</Label><Input id="schedule.interval" inputMode="numeric" value={form.interval} onChange={(e) => set({ interval: e.target.value })} {...invalid("schedule.interval")} /></div>
              <div><Label htmlFor="schedule.freq" className="sr-only">Unit</Label>
                <NativeSelect id="schedule.freq" value={form.freq} onChange={(e) => set({ freq: e.target.value as RecurringFreq })}>{(Object.keys(FREQ_UNIT) as RecurringFreq[]).map((f) => <NativeSelectOption key={f} value={f}>{FREQ_UNIT[f]}</NativeSelectOption>)}</NativeSelect></div>
              <div><Label htmlFor="schedule.time" className="sr-only">Time</Label><Input id="schedule.time" type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} {...invalid("schedule.time")} /></div>
            </div>
            {(err("schedule.interval") || err("schedule.time")) && <p role="alert" className="text-xs text-destructive">{err("schedule.interval") ?? err("schedule.time")}</p>}
            {form.freq === "weekly" && <div role="group" aria-label="Weekdays" className="space-y-1.5"><div className="flex flex-wrap gap-1.5">
              {WEEKDAY_NAMES.map((name, d) => { const on = form.weekdays.includes(d); return <button key={d} type="button" aria-pressed={on} onClick={() => set({ weekdays: on ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d] })} className={`h-8 min-w-11 rounded-full border px-2.5 text-xs ${on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>{name}</button>; })}
            </div>{err("schedule.weekdays") && <p role="alert" className="text-xs text-destructive">{err("schedule.weekdays")}</p>}</div>}
            {form.freq === "monthly" && <Field label="Day of month" id="schedule.monthDay" error={err("schedule.monthDay")} hint="31 means the last day of shorter months."><Input id="schedule.monthDay" className="w-24" inputMode="numeric" value={form.monthDay} onChange={(e) => set({ monthDay: e.target.value })} {...invalid("schedule.monthDay")} /></Field>}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Starts" id="schedule.startDate" error={err("schedule.startDate")}><Input id="schedule.startDate" type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} {...invalid("schedule.startDate")} /></Field>
              <Field label="Time zone" id="schedule.timezone" error={err("schedule.timezone")}><Input id="schedule.timezone" value={form.timezone} onChange={(e) => set({ timezone: e.target.value })} list="tz-suggestions" {...invalid("schedule.timezone")} />
                <datalist id="tz-suggestions"><option value={browserTimezone()} /><option value="UTC" /></datalist></Field>
            </div>
            <div className="grid items-end gap-3 sm:grid-cols-2">
              <Field label="Ends" id="end-mode"><NativeSelect id="end-mode" className="w-full" value={form.endMode} onChange={(e) => set({ endMode: e.target.value as ScheduleForm["endMode"] })}>
                <NativeSelectOption value="never">Never</NativeSelectOption><NativeSelectOption value="date">On a date</NativeSelectOption><NativeSelectOption value="count">After a number of runs</NativeSelectOption></NativeSelect></Field>
              {form.endMode === "date" && <Field label="End date" id="schedule.endDate" error={err("schedule.endDate")}><Input id="schedule.endDate" type="date" value={form.endDate} onChange={(e) => set({ endDate: e.target.value })} {...invalid("schedule.endDate")} /></Field>}
              {form.endMode === "count" && <Field label="Number of runs" id="schedule.count" error={err("schedule.count")}><Input id="schedule.count" inputMode="numeric" value={form.count} onChange={(e) => set({ count: e.target.value })} {...invalid("schedule.count")} /></Field>}
            </div>
          </div>
        )}
        <div className="rounded-lg bg-background/50 p-2.5 text-sm" aria-live="polite">
          <p className="font-medium">{sentence ?? "Complete the schedule to see when it runs."}</p>
          {previewError && <p className="mt-1 text-xs text-destructive">{previewError}</p>}
          {upcoming && <div className="mt-1.5"><p className="text-xs text-muted-foreground">Next runs</p>
            {upcoming.length === 0 ? <p className="text-xs">No more runs.</p> : <ul className="text-xs">{upcoming.map((u) => <li key={u}>{formatWhen(u, form.mode === "repeat" ? form.timezone : undefined)}{form.mode === "repeat" ? ` (${form.timezone})` : ""}</li>)}</ul>}</div>}
        </div>
      </fieldset>

      <Field label="If the app was off at run time" id="catch-up" hint={catchUp === "once" ? "A missed run happens once when Floq is back." : "Missed runs are skipped; the next one happens as scheduled."}>
        <NativeSelect id="catch-up" className="w-full" value={catchUp} onChange={(e) => setCatchUp(e.target.value as CatchUp)}><NativeSelectOption value="once">Run once to catch up</NativeSelectOption><NativeSelectOption value="skip">Skip it</NativeSelectOption></NativeSelect>
      </Field>
      <div className="flex items-center justify-between rounded-lg border px-3 py-2"><Label htmlFor="auto-enabled">Enabled</Label><Switch id="auto-enabled" checked={enabled} onCheckedChange={setEnabled} /></div>
      <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? "Saving…" : automation ? "Save" : "Create"}</Button></DialogFooter>
    </form>
  );
}
