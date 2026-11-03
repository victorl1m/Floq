import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { IconArrowRight, IconCheck, IconChecklist, IconCopy, IconPlus, IconTrash, IconUsers } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { copyText } from "@/lib/clipboard";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { TaskBoard, TaskCard, TaskTeam } from "@/lib/runtime/types";

type Cursor = { userId: string; name: string; x: number; y: number };
type RealtimeFrame = { type: "hello" | "board"; board: TaskBoard } | { type: "presence"; userId: string; name: string; x: number; y: number } | { type: "presence-left"; userId: string };

export default function TasksPage() {
  const { client, user } = useRuntime();
  const [teams, setTeams] = useState<TaskTeam[]>([]);
  const [teamId, setTeamId] = useState("");
  const [boards, setBoards] = useState<Omit<TaskBoard, "lists">[]>([]);
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [boardId, setBoardId] = useState("");
  const [cursors, setCursors] = useState<Cursor[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teamName, setTeamName] = useState("");
  const [boardName, setBoardName] = useState("");
  const [listName, setListName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [acceptToken, setAcceptToken] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [addingCardTo, setAddingCardTo] = useState<string | null>(null);
  const [newCardTitle, setNewCardTitle] = useState("");
  const [newCardDescription, setNewCardDescription] = useState("");
  const boardSurface = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const selectedTeam = teams.find((team) => team.id === teamId) ?? null;

  const loadTeams = useCallback(async (preferred?: string) => {
    if (!client) return;
    const loaded = await client.teams();
    setTeams(loaded);
    setTeamId((current) => preferred && loaded.some((team) => team.id === preferred) ? preferred : loaded.some((team) => team.id === current) ? current : loaded[0]?.id ?? "");
  }, [client]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    client?.teams().then((loaded) => {
      if (!live) return;
      setTeams(loaded);
      setTeamId(loaded[0]?.id ?? "");
      setError(null);
    }).catch((reason) => live && setError(errorMessage(reason))).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [client]);

  useEffect(() => {
    if (!client || !teamId) { setBoards([]); setBoard(null); setBoardId(""); return; }
    let live = true;
    setBoard(null);
    client.teamBoards(teamId).then((loaded) => {
      if (!live) return;
      setBoards(loaded);
      setBoardId((current) => loaded.some((item) => item.id === current) ? current : loaded[0]?.id ?? "");
      setError(null);
    }).catch((reason) => live && setError(errorMessage(reason)));
    return () => { live = false; };
  }, [client, teamId]);

  const refreshBoard = useCallback(async () => {
    if (!client || !boardId) return;
    setBoard(await client.taskBoard(boardId));
  }, [client, boardId]);

  const retryLoad = async () => {
    if (!client) return;
    setError(null);
    try {
      if (!teams.length || !teamId) { await loadTeams(); return; }
      const loaded = await client.teamBoards(teamId);
      setBoards(loaded);
      const nextBoardId = loaded.some((item) => item.id === boardId) ? boardId : loaded[0]?.id ?? "";
      setBoardId(nextBoardId);
      setBoard(nextBoardId ? await client.taskBoard(nextBoardId) : null);
    } catch (reason) { setError(errorMessage(reason)); }
  };

  useEffect(() => {
    if (!client || !boardId) { setBoard(null); setCursors([]); return; }
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (closed) return;
      try { socket = new WebSocket(client.taskRealtimeUrl(boardId)); }
      catch (reason) { setError(errorMessage(reason)); return; }
      socketRef.current = socket;
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as RealtimeFrame;
          if (frame.type === "hello" || frame.type === "board") setBoard(frame.board);
          if (frame.type === "presence") setCursors((items) => [...items.filter((item) => item.userId !== frame.userId), frame]);
          if (frame.type === "presence-left") setCursors((items) => items.filter((item) => item.userId !== frame.userId));
        } catch { /* Ignore malformed runtime frames; reconnect retrieves a fresh snapshot. */ }
      };
      socket.onclose = () => {
        if (!closed) retry = setTimeout(connect, 1800);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
      socketRef.current = null;
    };
  }, [client, boardId]);

  const members = selectedTeam?.members ?? [];
  const doMutation = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError(null);
    try { await action(); if (success) toast.success(success); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const onCreateTeam = async (event: FormEvent) => {
    event.preventDefault();
    if (!teamName.trim() || !client) return;
    await doMutation(async () => { const team = await client.createTeam(teamName); setTeamName(""); await loadTeams(team.id); }, "Team created");
  };
  const onCreateBoard = async (event: FormEvent) => {
    event.preventDefault();
    if (!boardName.trim() || !client || !teamId) return;
    await doMutation(async () => { const created = await client.createTaskBoard(teamId, boardName); setBoardName(""); setBoards(await client.teamBoards(teamId)); setBoardId(created.id); setBoard(created); }, "Board created");
  };
  const onInvite = async (event: FormEvent) => {
    event.preventDefault();
    if (!inviteEmail.trim() || !client || !teamId) return;
    await doMutation(async () => { const invite = await client.createTeamInvitation(teamId, inviteEmail); setInviteToken(invite.token); setInviteEmail(""); }, "Invitation created");
  };
  const onAccept = async (event: FormEvent) => {
    event.preventDefault();
    if (!acceptToken.trim() || !client) return;
    await doMutation(async () => { const accepted = await client.acceptTeamInvitation(acceptToken.trim()); setAcceptToken(""); await loadTeams(accepted.teamId); }, "You joined the team");
  };
  const onCreateList = async (event: FormEvent) => {
    event.preventDefault();
    if (!boardId || !client || !listName.trim()) return;
    await doMutation(async () => { await client.createTaskList(boardId, listName); setListName(""); await refreshBoard(); }, "List created");
  };
  const onCreateCard = async (event: FormEvent, listId: string) => {
    event.preventDefault();
    if (!client || !boardId || !newCardTitle.trim()) return;
    await doMutation(async () => {
      await client.createTaskCard(boardId, { listId, title: newCardTitle, description: newCardDescription });
      setNewCardTitle(""); setNewCardDescription(""); setAddingCardTo(null); await refreshBoard();
    }, "Card created");
  };
  const moveCard = async (card: TaskCard, listId: string) => {
    if (!client || !boardId || listId === board?.lists.find((list) => list.cards.some((item) => item.id === card.id))?.id) return;
    await doMutation(async () => { await client.saveTaskCard(boardId, card.id, { listId, title: card.title, description: card.description, position: card.position, assigneeId: card.assigneeId, dueAt: card.dueAt }); await refreshBoard(); }, "Card moved");
  };
  const updateBoard = async (event: FormEvent) => {
    event.preventDefault();
    if (!board || !client) return;
    const title = boardName.trim();
    if (!title) return;
    await doMutation(async () => { await client.saveTaskBoard(board.id, title); await refreshBoard(); setBoardName(""); }, "Board renamed");
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = boardSurface.current?.getBoundingClientRect();
    const socket = socketRef.current;
    if (!rect || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "cursor", x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }));
  };

  const completedCount = useMemo(() => board?.lists[board.lists.length - 1]?.cards.length ?? 0, [board]);
  if (loading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;

  return (
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-6 py-4">
        <div className="mr-auto min-w-48">
          <p className="text-[11px] font-medium uppercase tracking-[0.13em] text-muted-foreground">Team workspace</p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight">Tasks</h1>
        </div>
        <label className="sr-only" htmlFor="task-team">Choose team</label>
        <select id="task-team" className="h-8 min-w-40 max-w-56 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50" value={teamId} onChange={(event) => setTeamId(event.target.value)}>
          {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          {!teams.length && <option value="">No teams yet</option>}
        </select>
        {selectedTeam && <Badge variant="outline"><IconUsers />{members.length} {members.length === 1 ? "member" : "members"}</Badge>}
        <label className="sr-only" htmlFor="task-board">Choose board</label>
        <select id="task-board" className="h-8 min-w-40 max-w-56 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50" value={boardId} disabled={!boards.length} onChange={(event) => setBoardId(event.target.value)}>
          {boards.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          {!boards.length && <option value="">No boards yet</option>}
        </select>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error && <div role="alert" className="mx-6 mt-4 flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><span>{error}</span><Button size="sm" variant="outline" onClick={() => void retryLoad()}>Retry</Button></div>}
        {!teams.length ? (
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-6 py-12">
            <span className="mb-4 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Start together</span>
            <h2 className="max-w-lg text-3xl font-semibold tracking-tight">Give the work a place to move.</h2>
            <p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">Create a team to share boards, assign work, and see teammates working on the same board in real time.</p>
            <form className="mt-7 flex max-w-md gap-2" noValidate onSubmit={onCreateTeam}>
              <label className="sr-only" htmlFor="new-team">Team name</label><Input id="new-team" maxLength={80} placeholder="Team name" value={teamName} onChange={(event) => setTeamName(event.target.value)} />
              <Button disabled={busy || !teamName.trim()}><IconPlus />Create team</Button>
            </form>
            <form className="mt-8 flex max-w-md items-center gap-2 border-t pt-5" noValidate onSubmit={onAccept}>
              <label className="sr-only" htmlFor="accept-invite">Invitation token</label><Input id="accept-invite" placeholder="Invitation token" value={acceptToken} onChange={(event) => setAcceptToken(event.target.value)} />
              <Button variant="outline" disabled={busy || !acceptToken.trim()}>Join team</Button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">Already invited? Sign in with the invited email, then paste the token here.</p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3 border-b px-6 py-3">
              <form className="flex min-w-52 flex-1 gap-2" noValidate onSubmit={onCreateBoard}>
                <label className="sr-only" htmlFor="new-board">New board name</label><Input id="new-board" maxLength={120} placeholder="New board name" value={boardName} onChange={(event) => setBoardName(event.target.value)} />
                <Button size="sm" disabled={busy || !boardName.trim()}><IconPlus />Create board</Button>
              </form>
              {selectedTeam?.role === "owner" && <form className="flex min-w-64 flex-1 gap-2" noValidate onSubmit={onInvite}>
                <label className="sr-only" htmlFor="invite-email">Teammate email</label><Input id="invite-email" type="email" maxLength={254} placeholder="Teammate email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
                <Button size="sm" variant="outline" disabled={busy || !inviteEmail.trim()}><IconUsers />Invite</Button>
              </form>}
              {inviteToken && <div className="flex min-w-0 basis-full items-center gap-2 rounded-lg bg-muted/60 p-2 text-xs sm:basis-auto"><span className="shrink-0 font-medium">Invite token</span><code className="max-w-48 truncate font-mono text-muted-foreground">{inviteToken}</code><Button size="icon-xs" variant="ghost" aria-label="Copy invitation token" onClick={() => void copyText(inviteToken).then(() => toast.success("Invitation token copied")).catch(() => toast.error("Could not copy token"))}><IconCopy /></Button></div>}
            </div>

            {selectedTeam && <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">People</span>
              {members.map((member) => <span key={member.id} className="rounded-full border px-2 py-1">{member.name || member.email}{member.role === "owner" ? " · owner" : ""}</span>)}
              <form className="ml-auto flex min-w-56 gap-1.5" noValidate onSubmit={onAccept}>
                <label className="sr-only" htmlFor="accept-team-token">Invitation token</label><Input className="h-7 max-w-52 text-xs" id="accept-team-token" placeholder="Paste invite token" value={acceptToken} onChange={(event) => setAcceptToken(event.target.value)} />
                <Button size="sm" variant="ghost" disabled={busy || !acceptToken.trim()}>Join<IconArrowRight /></Button>
              </form>
            </div>}

            {!board ? (
              <div className="flex flex-1 flex-col items-center justify-center px-6 py-14 text-center">
                <div className="grid size-12 place-items-center rounded-xl border bg-muted/40"><IconChecklist className="size-6 text-muted-foreground" /></div>
                <h2 className="mt-4 text-base font-semibold">{boards.length ? "Choose a board" : "No boards on this team yet"}</h2>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">{boards.length ? "Select a board above to see its lists and cards." : "Create a board to organize the next pieces of work."}</p>
              </div>
            ) : (
              <div className="relative flex min-h-0 flex-1 flex-col" ref={boardSurface} onPointerMove={onPointerMove}>
                {cursors.filter((cursor) => cursor.userId !== user?.id).map((cursor) => <div key={cursor.userId} className="pointer-events-none absolute z-20 transition-[left,top] duration-75" style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }} aria-hidden="true"><div className="flex items-center gap-1.5"><span className="size-3 rotate-[-25deg] rounded-sm rounded-bl-none bg-primary shadow" /><span className="rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground shadow">{cursor.name}</span></div></div>)}
                <div className="flex flex-wrap items-center gap-3 border-b px-6 py-3">
                  <div className="min-w-48 flex-1"><p className="text-[11px] uppercase tracking-widest text-muted-foreground">{selectedTeam?.name}</p><h2 className="text-lg font-semibold">{board.title}</h2></div>
                  <form className="flex gap-1.5" noValidate onSubmit={updateBoard}><label className="sr-only" htmlFor="rename-board">Rename board</label><Input className="h-7 w-40" id="rename-board" maxLength={120} placeholder="Rename board" value={boardName} onChange={(event) => setBoardName(event.target.value)} /><Button size="sm" variant="outline" disabled={busy || !boardName.trim()}>Save name</Button></form>
                  {selectedTeam?.role === "owner" && <Button size="icon-sm" variant="ghost" aria-label="Delete board" onClick={() => setDeleteOpen(true)}><IconTrash className="text-destructive" /></Button>}
                  <Badge variant="secondary"><IconCheck />{completedCount} done</Badge>
                </div>
                <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto overflow-y-hidden p-5" aria-label={`${board.title} board`}>
                  {board.lists.map((list) => <section key={list.id} className="flex max-h-full w-[min(19rem,84vw)] shrink-0 flex-col rounded-xl border bg-muted/30" aria-labelledby={`list-${list.id}`}>
                    <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5"><h3 id={`list-${list.id}`} className="truncate text-sm font-semibold">{list.title}</h3><div className="flex items-center gap-1"><Badge variant="outline">{list.cards.length}</Badge><Button size="icon-xs" variant="ghost" aria-label={`Delete ${list.title} list`} onClick={() => void doMutation(async () => { await client?.deleteTaskList(board.id, list.id); await refreshBoard(); }, "List deleted")}><IconTrash className="size-3 text-muted-foreground" /></Button></div></header>
                    <div className="min-h-10 space-y-2 overflow-y-auto p-2.5">
                      {list.cards.map((card) => <article key={card.id} className="rounded-lg border bg-card p-3 shadow-sm">
                        <h4 className="text-sm font-medium leading-5">{card.title}</h4>
                        {card.description && <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{card.description}</p>}
                        <div className="mt-3 flex items-center gap-1.5">
                          <label className="sr-only" htmlFor={`move-${card.id}`}>Move {card.title} to list</label>
                          <select id={`move-${card.id}`} aria-label={`Move ${card.title} to list`} className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs" value={list.id} onChange={(event) => void moveCard(card, event.target.value)}>
                            {board.lists.map((target) => <option key={target.id} value={target.id}>{target.title}</option>)}
                          </select>
                          {card.assigneeId && <Badge variant="outline" className="max-w-24 truncate">{members.find((item) => item.id === card.assigneeId)?.name || "Assigned"}</Badge>}
                          <Button size="icon-xs" variant="ghost" aria-label={`Delete ${card.title}`} onClick={() => void doMutation(async () => { await client?.deleteTaskCard(board.id, card.id); await refreshBoard(); }, "Card deleted")}><IconTrash className="size-3 text-muted-foreground" /></Button>
                        </div>
                      </article>)}
                    </div>
                    {addingCardTo === list.id ? <form className="space-y-2 border-t p-2.5" noValidate onSubmit={(event) => void onCreateCard(event, list.id)}>
                      <label className="sr-only" htmlFor={`card-title-${list.id}`}>Card title</label><Input autoFocus id={`card-title-${list.id}`} maxLength={200} placeholder="What needs doing?" value={newCardTitle} onChange={(event) => setNewCardTitle(event.target.value)} />
                      <label className="sr-only" htmlFor={`card-description-${list.id}`}>Card details</label><Textarea id={`card-description-${list.id}`} maxLength={5000} className="min-h-14 resize-none text-xs" placeholder="Add a note (optional)" value={newCardDescription} onChange={(event) => setNewCardDescription(event.target.value)} />
                      <div className="flex justify-end gap-1.5"><Button size="sm" variant="ghost" type="button" onClick={() => setAddingCardTo(null)}>Cancel</Button><Button size="sm" disabled={busy || !newCardTitle.trim()}>Add card</Button></div>
                    </form> : <Button className="m-2 mt-0 justify-start text-muted-foreground" size="sm" variant="ghost" onClick={() => setAddingCardTo(list.id)}><IconPlus />Add a card</Button>}
                  </section>)}
                  <form className="flex w-60 shrink-0 gap-1.5 rounded-xl border border-dashed p-2" noValidate onSubmit={onCreateList}><label className="sr-only" htmlFor="new-list">New list name</label><Input id="new-list" maxLength={80} placeholder="Add a list" value={listName} onChange={(event) => setListName(event.target.value)} /><Button size="icon-sm" variant="outline" aria-label="Create list" disabled={busy || !listName.trim()}><IconPlus /></Button></form>
                </div>
                <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                  <AlertDialogContent>
                    <AlertDialogHeader><AlertDialogTitle>Delete “{board.title}”?</AlertDialogTitle><AlertDialogDescription>This permanently deletes the board, its lists, and every card. Team members will lose access immediately.</AlertDialogDescription></AlertDialogHeader>
                    <AlertDialogFooter><AlertDialogCancel>Keep board</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void doMutation(async () => { await client?.deleteTaskBoard(board.id); const remaining = await client?.teamBoards(teamId) ?? []; setBoards(remaining); setBoardId(remaining[0]?.id ?? ""); setBoard(null); }, "Board deleted")}>Delete board</AlertDialogAction></AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
