import { useEffect, useState, type FormEvent } from "react";
import { IconCalendar, IconTrash } from "@tabler/icons-react";
import { AppDialog, ErrorBanner } from "@/components/ui/app-dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { TaskBoard, TaskCard, TaskTeam } from "@/lib/runtime/types";

interface TaskCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  board: TaskBoard;
  card: TaskCard | null;
  members: TaskTeam["members"];
  busy: boolean;
  error: string | null;
  onSave: (card: TaskCard, input: { listId: string; title: string; description: string; position: number; assigneeId: string | null; dueAt: string | null }) => Promise<boolean>;
  onDelete: (card: TaskCard) => void;
}

function calendarDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day);
}

function dueAtForDate(date: Date): string {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12)).toISOString();
}

function dueDateLabel(value: string): string {
  return calendarDate(value)?.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) ?? "Choose a date";
}

export default function TaskCardDialog({ open, onOpenChange, board, card, members, busy, error, onSave, onDelete }: TaskCardDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [listId, setListId] = useState("");
  const [assigneeId, setAssigneeId] = useState("none");
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const currentListId = board.lists.find((list) => list.cards.some((item) => item.id === card?.id))?.id ?? board.lists[0]?.id ?? "";

  useEffect(() => {
    if (!open || !card) return;
    setTitle(card?.title ?? "");
    setDescription(card?.description ?? "");
    setListId(currentListId);
    setAssigneeId(card?.assigneeId ?? "none");
    setDueAt(card?.dueAt ?? null);
  }, [open, board.id, card?.id]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!card || !title.trim() || !listId) return;
    if (await onSave(card, { listId, title: title.trim(), description, position: card.position, assigneeId: assigneeId === "none" ? null : assigneeId, dueAt })) onOpenChange(false);
  };

  return (
    <AppDialog
      open={open && !!card}
      onOpenChange={onOpenChange}
      icon={<IconCalendar />}
      title="Card details"
      description={board.title}
      size="md"
      className="sm:max-w-[560px]"
      footer={<>
        <Button type="button" variant="ghost" className="mr-auto text-destructive hover:text-destructive" disabled={busy || !card} onClick={() => card && onDelete(card)}><IconTrash />Delete card</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button form="task-card-form" disabled={busy || !card || !title.trim() || !listId}>Save changes</Button>
      </>}
    >
      <form id="task-card-form" noValidate className="space-y-4" onSubmit={(event) => void submit(event)}>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <div className="space-y-2"><Label htmlFor="task-card-title">Title</Label><Input id="task-card-title" autoFocus maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="task-card-description">Description</Label><Textarea id="task-card-description" maxLength={5000} className="min-h-28 resize-none" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="task-card-list">List</Label>
            <Select value={listId} onValueChange={setListId}>
              <SelectTrigger id="task-card-list" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent avoidCollisions position="popper" className="w-[var(--radix-select-trigger-width)] min-w-0">{board.lists.map((list) => <SelectItem key={list.id} value={list.id} textValue={list.title}><span className="min-w-0 flex-1 truncate">{list.title}</span></SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2"><Label htmlFor="task-card-assignee">Assignee</Label>
            <Select value={assigneeId} onValueChange={setAssigneeId}>
              <SelectTrigger id="task-card-assignee" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent avoidCollisions position="popper" className="w-[var(--radix-select-trigger-width)] min-w-0">
                <SelectItem value="none">Unassigned</SelectItem>
                {members.map((member) => <SelectItem key={member.id} value={member.id} textValue={member.name || member.email}><span className="min-w-0 flex-1 truncate">{member.name || member.email}</span></SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2"><Label>Due date <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <div className="flex items-center gap-2">
            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger asChild><Button type="button" variant="outline" className="min-w-0 flex-1 justify-start font-normal"><IconCalendar />{dueDateLabel(dueAt ?? "")}</Button></PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-0"><Calendar mode="single" selected={calendarDate(dueAt)} onSelect={(date) => { setDueAt(date ? dueAtForDate(date) : null); setCalendarOpen(false); }} /></PopoverContent>
            </Popover>
            {dueAt && <Button type="button" variant="ghost" size="sm" onClick={() => setDueAt(null)}>Clear</Button>}
          </div>
        </div>
      </form>
    </AppDialog>
  );
}
