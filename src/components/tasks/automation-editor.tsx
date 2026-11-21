import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { IconCalendarRepeat } from "@tabler/icons-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pick } from "./task-ui";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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
    <DialogContent className="flex max-h-[92vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">{open && <Form key={automation?.id ?? "new"} automation={automation} projectId={projectId} projects={projects} onClose={onClose} onSaved={onSaved} />}</DialogContent>
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
  const errorCount = Object.keys(errors).length;
  const repeatLine = err("schedule.interval") ?? err("schedule.time");
  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <DialogHeader className="border-b px-6 pt-6 pb-4">
        <DialogTitle>{automation ? "Edit automation" : "New automation"}</DialogTitle>
        <DialogDescription>Creates a task on a schedule. If “Agents work on tasks” is on for the project, its agent starts the task right away.</DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
        <section aria-labelledby="auto-what" className="space-y-3">
          <h3 id="auto-what" className="text-sm font-medium">What the agent does</h3>
          <div className="settings-group space-y-4 [&>div]:p-0!" style={{ padding: "16px 18px" }}>
            {!automation && !projectId && <Field label="Project" id="auto-project"><Pick id="auto-project" className="w-full" value={project} onChange={setProject} options={projects.map((p) => ({ value: p.id, label: p.label }))} /></Field>}
            <Field label="Name" id="title" error={err("title")}><Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Monthly billing report" autoFocus={!automation} {...invalid("title")} /></Field>
            <Field label="Instructions" id="instructions" error={err("instructions")} hint="This becomes the task description. Markdown works.">
              <Textarea id="instructions" rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="What should the agent do each time, and what should it hand back?" className="min-h-24" {...invalid("instructions")} />
            </Field>
          </div>
        </section>

        <section aria-labelledby="auto-when" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="auto-when" className="text-sm font-medium">When it runs</h3>
            <div role="radiogroup" aria-labelledby="auto-when" className="inline-flex h-8 items-center rounded-lg bg-muted p-[3px]"
              onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const m = form.mode === "once" ? "repeat" : "once"; set({ mode: m }); (e.currentTarget.querySelector(`[data-mode="${m}"]`) as HTMLElement | null)?.focus(); } }}>
              {(["once", "repeat"] as const).map((m) => (
                <button key={m} type="button" role="radio" data-mode={m} aria-checked={form.mode === m} tabIndex={form.mode === m ? 0 : -1} onClick={() => set({ mode: m })}
                  className={cn("h-full rounded-md border border-transparent px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring", form.mode === m ? "border-border/80 bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {m === "once" ? "Once" : "Repeat"}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-group divide-y divide-border">
            {form.mode === "once" ? (
              <div className="space-y-1.5">
                <Field label="Date and time" id="schedule.at" error={err("schedule.at")} hint="In your time zone.">
                  <Input id="schedule.at" type="datetime-local" className="sm:max-w-64" value={form.onceAt} onChange={(e) => set({ onceAt: e.target.value })} {...invalid("schedule.at")} />
                </Field>
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  {/* The schedule reads as a sentence: Every [1] [weeks] at [09:00]. */}
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span>Every</span>
                    <Label htmlFor="schedule.interval" className="sr-only">Interval</Label>
                    <Input id="schedule.interval" inputMode="numeric" className="w-16 text-center tabular-nums" value={form.interval} onChange={(e) => set({ interval: e.target.value })} {...invalid("schedule.interval")} />
                    <Label htmlFor="schedule.freq" className="sr-only">Unit</Label>
                    <Pick id="schedule.freq" value={form.freq} onChange={(v) => set({ freq: v as RecurringFreq })} options={(Object.keys(FREQ_UNIT) as RecurringFreq[]).map((f) => ({ value: f, label: unitLabel(f, form.interval) }))} />
                    <span>at</span>
                    <Label htmlFor="schedule.time" className="sr-only">Time</Label>
                    <Input id="schedule.time" type="time" className="w-28" value={form.time} onChange={(e) => set({ time: e.target.value })} aria-invalid={!!err("schedule.time")} aria-describedby={err("schedule.time") ? "schedule.interval-err" : undefined} />
                  </div>
                  {repeatLine && <p id="schedule.interval-err" role="alert" className="text-xs text-destructive">{repeatLine}</p>}
                  {form.freq === "weekly" && (
                    <div role="group" aria-label="Weekdays" className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">On</p>
                      <div className="flex flex-wrap gap-1.5">
                        {WEEKDAY_NAMES.map((name, d) => { const on = form.weekdays.includes(d); return <button key={d} type="button" aria-pressed={on} onClick={() => set({ weekdays: on ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d] })} className={cn("h-8 min-w-11 rounded-full border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background", on ? "border-primary bg-primary text-primary-foreground" : "bg-card/60 text-muted-foreground hover:bg-muted hover:text-foreground")}>{name}</button>; })}
                      </div>
                      {err("schedule.weekdays") && <p role="alert" className="text-xs text-destructive">{err("schedule.weekdays")}</p>}
                    </div>
                  )}
                  {form.freq === "monthly" && <Field label="Day of month" id="schedule.monthDay" error={err("schedule.monthDay")} hint="31 means the last day of shorter months."><Input id="schedule.monthDay" className="w-20 tabular-nums" inputMode="numeric" value={form.monthDay} onChange={(e) => set({ monthDay: e.target.value })} {...invalid("schedule.monthDay")} /></Field>}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Starts" id="schedule.startDate" error={err("schedule.startDate")}><Input id="schedule.startDate" type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} {...invalid("schedule.startDate")} /></Field>
                  <Field label="Time zone" id="schedule.timezone" error={err("schedule.timezone")}><Input id="schedule.timezone" value={form.timezone} onChange={(e) => set({ timezone: e.target.value })} list="tz-suggestions" {...invalid("schedule.timezone")} />
                    <datalist id="tz-suggestions"><option value={browserTimezone()} /><option value="UTC" /></datalist></Field>
                  <Field label="Ends" id="end-mode"><Pick id="end-mode" className="w-full" value={form.endMode} onChange={(v) => set({ endMode: v as ScheduleForm["endMode"] })}
                    options={[{ value: "never", label: "Never" }, { value: "date", label: "On a date" }, { value: "count", label: "After a number of runs" }]} /></Field>
                  {form.endMode === "date" && <Field label="End date" id="schedule.endDate" error={err("schedule.endDate")}><Input id="schedule.endDate" type="date" value={form.endDate} onChange={(e) => set({ endDate: e.target.value })} {...invalid("schedule.endDate")} /></Field>}
                  {form.endMode === "count" && <Field label="Number of runs" id="schedule.count" error={err("schedule.count")}><Input id="schedule.count" inputMode="numeric" value={form.count} onChange={(e) => set({ count: e.target.value })} {...invalid("schedule.count")} /></Field>}
                </div>
              </>
            )}
            {/* Read-back: the sentence and the next runs the scheduler will actually use. */}
            <div className="bg-[var(--glass-row-hover)]" aria-live="polite">
              <div className="flex gap-3">
                <IconCalendarRepeat aria-hidden className={cn("mt-0.5 size-4 shrink-0", sentence ? "text-primary-text" : "text-muted-foreground")} />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className={cn("text-sm leading-snug", sentence ? "font-medium" : "text-muted-foreground")}>{sentence ?? "Finish the schedule to see when it runs."}</p>
                  {previewError && <p className="text-xs text-destructive">{previewError}</p>}
                  {upcoming && (upcoming.length === 0
                    ? <p className="text-xs text-muted-foreground">No more runs.</p>
                    : <div className="space-y-1"><p className="text-xs text-muted-foreground">Next runs</p>
                      <ul className="flex flex-wrap gap-1.5">{upcoming.map((u) => <li key={u} className="rounded-md bg-card/80 px-2 py-0.5 text-xs tabular-nums ring-1 ring-border">{formatWhen(u, form.mode === "repeat" ? form.timezone : undefined)}</li>)}</ul>
                      {form.mode === "repeat" && <p className="text-[11px] text-muted-foreground">Times in {form.timezone}</p>}</div>)}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="auto-more" className="space-y-3">
          <h3 id="auto-more" className="text-sm font-medium">More options</h3>
          <div className="settings-group divide-y divide-border">
            <fieldset className="space-y-2.5" style={{ padding: "16px 18px" }}>
              <legend className="float-left mb-2.5 w-full text-sm font-medium">If Floq was off at run time</legend>
              {([["once", "Run once to catch up", "A missed run happens once when Floq is back."], ["skip", "Skip it", "Missed runs are skipped; the next one happens as scheduled."]] as const).map(([value, title, hint]) => (
                <label key={value} className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors", catchUp === value ? "border-ring/60 bg-[var(--glass-row-active)]" : "border-transparent hover:bg-[var(--glass-row-hover)]")}>
                  <input type="radio" name="catch-up" value={value} checked={catchUp === value} onChange={() => setCatchUp(value)} className="mt-0.5 size-4 accent-[var(--primary)]" />
                  <span className="min-w-0"><span className="block text-sm font-medium">{title}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
                </label>
              ))}
            </fieldset>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0"><Label htmlFor="auto-enabled">Enabled</Label><p className="text-xs text-muted-foreground">{enabled ? "Runs on schedule once saved." : "Saved paused: nothing runs until you turn it on."}</p></div>
              <Switch id="auto-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </div>
        </section>
      </div>

      <DialogFooter className="items-center border-t px-6 py-3.5 sm:justify-between">
        <p className="text-xs text-destructive" role={errorCount ? "alert" : undefined}>{errorCount ? `Fix ${errorCount === 1 ? "1 field" : `${errorCount} fields`} to save.` : ""}</p>
        <div className="flex gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? "Saving…" : automation ? "Save" : "Create automation"}</Button></div>
      </DialogFooter>
    </form>
  );
}

function unitLabel(f: RecurringFreq, interval: string): string {
  const one = interval.trim() === "1";
  return { daily: one ? "day" : "days", weekly: one ? "week" : "weeks", monthly: one ? "month" : "months", yearly: one ? "year" : "years" }[f];
}
