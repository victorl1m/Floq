import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { IconArrowRight, IconChecklist, IconCopy, IconDots, IconPlus, IconTrash, IconUsers, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { Label } from "@/components/ui/label";
import { AppDialog, ErrorBanner } from "@/components/ui/app-dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTitlebarSlot } from "@/lib/titlebar-slot";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { copyText } from "@/lib/clipboard";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { TaskBoard, TaskCard } from "@/lib/runtime/types";
import TaskBoardNavigator from "./task-board-navigator";
import TaskCardDialog from "./task-card-dialog";

type Cursor = { userId: string; name: string; x: number; y: number };
type RealtimeFrame = { type: "hello" | "board"; board: TaskBoard } | { type: "presence"; userId: string; name: string; x: number; y: number } | { type: "presence-left"; userId: string };
type BoardNavigationPreferences = { favorites: string[]; recent: string[]; openTabs: string[]; activeBoardId: string; tabsInitialized: boolean };

function readBoardNavigationPreferences(key: string): BoardNavigationPreferences {
  if (!key) return { favorites: [], recent: [], openTabs: [], activeBoardId: "", tabsInitialized: false };
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as { version?: number; favorites?: unknown; recent?: unknown; openTabs?: unknown; activeBoardId?: unknown; tabsInitialized?: unknown } | null;
    if (parsed?.version !== 1) return { favorites: [], recent: [], openTabs: [], activeBoardId: "", tabsInitialized: false };
    const ids = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
    return {
      favorites: ids(parsed.favorites),
      recent: Array.isArray(parsed.recent) ? parsed.recent.filter((id): id is string => typeof id === "string").slice(0, 12) : [],
      openTabs: ids(parsed.openTabs),
      activeBoardId: typeof parsed.activeBoardId === "string" ? parsed.activeBoardId : "",
      tabsInitialized: typeof parsed.tabsInitialized === "boolean" ? parsed.tabsInitialized : Array.isArray(parsed.openTabs),
    };
  } catch { return { favorites: [], recent: [], openTabs: [], activeBoardId: "", tabsInitialized: false }; }
}

function formatTaskDueDate(value: string): string {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return "Due date";
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function TasksPage() {
  const { client, user, teams, teamsLoading, teamsError, refreshTeams, activeTeamId, selectTeam: selectActiveTeam } = useRuntime();
  const teamId = activeTeamId ?? "";
  const [boards, setBoards] = useState<Omit<TaskBoard, "lists">[]>([]);
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [boardId, setBoardId] = useState("");
  const [cursors, setCursors] = useState<Cursor[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teamName, setTeamName] = useState("");
  const [boardName, setBoardName] = useState("");
  const [listName, setListName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [acceptToken, setAcceptToken] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ title: string; description: string; action: () => Promise<void> } | null>(null);
  const [dialog, setDialog] = useState<"team" | "board" | "invite" | "join" | "rename" | null>(null);
  const [activeCard, setActiveCard] = useState<TaskCard | null>(null);
  const [boardPickerOpen, setBoardPickerOpen] = useState(false);
  const [pendingTabFocus, setPendingTabFocus] = useState<string | null>(null);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [dropTargetListId, setDropTargetListId] = useState<string | null>(null);
  const [navigationPreferences, setNavigationPreferences] = useState<{ scope: string; value: BoardNavigationPreferences }>({ scope: "", value: readBoardNavigationPreferences("") });
  const [boardsReadyScope, setBoardsReadyScope] = useState("");
  const [addingCardTo, setAddingCardTo] = useState<string | null>(null);
  const [newCardTitle, setNewCardTitle] = useState("");
  const [newCardDescription, setNewCardDescription] = useState("");
  const boardSurface = useRef<HTMLDivElement>(null);
  const boardTabStripRef = useRef<HTMLDivElement>(null);
  const boardTabRefs = useRef(new Map<string, HTMLButtonElement>());
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const titlebarSlot = useTitlebarSlot();
  const socketRef = useRef<WebSocket | null>(null);
  const boardRequest = useRef(0);
  const currentBoardId = useRef(boardId);
  currentBoardId.current = boardId;
  const currentTeamId = useRef(teamId);
  currentTeamId.current = teamId;
  const navigationScope = client && user && teamId
    ? `floq.tasks.navigation.v1:${encodeURIComponent(client.baseUrl)}:${encodeURIComponent(user.id)}:${encodeURIComponent(teamId)}`
    : "";
  const activeNavigationPreferences = navigationPreferences.scope === navigationScope ? navigationPreferences.value : readBoardNavigationPreferences("");
  const selectedTeam = teams.find((team) => team.id === teamId) ?? null;
  const visibleBoard = boardsReadyScope === navigationScope && board?.teamId === teamId ? board : null;
  const openedBoards = activeNavigationPreferences.openTabs.flatMap((id) => {
    if (boardsReadyScope !== navigationScope) return [];
    const item = boards.find((entry) => entry.id === id);
    return item ? [item] : [];
  });

  useEffect(() => {
    if (pendingTabFocus === null) return;
    if (pendingTabFocus) boardTabRefs.current.get(pendingTabFocus)?.focus();
    else pickerButtonRef.current?.focus();
    setPendingTabFocus(null);
  }, [pendingTabFocus, openedBoards.length]);

  useEffect(() => {
    const strip = boardTabStripRef.current;
    if (!strip) return;
    const ensureActiveTabVisible = () => {
      const tab = boardTabRefs.current.get(boardId);
      if (!tab) return;
      const stripRect = strip.getBoundingClientRect();
      const tabRect = tab.getBoundingClientRect();
      if (tabRect.left < stripRect.left) strip.scrollLeft -= stripRect.left - tabRect.left;
      else if (tabRect.right > stripRect.right) strip.scrollLeft += tabRect.right - stripRect.right;
    };
    ensureActiveTabVisible();
    const observer = new ResizeObserver(ensureActiveTabVisible);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [boardId, openedBoards.length, titlebarSlot]);

  useEffect(() => {
    setBoardsReadyScope("");
    setNavigationPreferences({ scope: navigationScope, value: readBoardNavigationPreferences(navigationScope) });
  }, [navigationScope]);

  useEffect(() => {
    if (!navigationScope || navigationPreferences.scope !== navigationScope || boardsReadyScope !== navigationScope) return;
    try { localStorage.setItem(navigationScope, JSON.stringify({ version: 1, ...navigationPreferences.value })); }
    catch { /* Favorites and recents are optional if storage is unavailable or full. */ }
  }, [navigationScope, navigationPreferences, boardsReadyScope]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() !== "b" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']"))) return;
      if (document.querySelector("[role='dialog'], [role='alertdialog']")) return;
      event.preventDefault();
      setBoardPickerOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!client || !teamId) { setBoards([]); setBoard(null); setBoardId(""); return; }
    let live = true;
    setBoards([]); setBoard(null); setBoardId(""); setCursors([]); setActiveCard(null); setAddingCardTo(null); setDraggingCardId(null); setDropTargetListId(null);
    client.teamBoards(teamId).then((loaded) => {
      if (!live) return;
      setBoards(loaded);
      const boardIds = new Set(loaded.map((item) => item.id));
      const saved = readBoardNavigationPreferences(navigationScope);
      const validFavorites = saved.favorites.filter((id) => boardIds.has(id));
      const validRecent = saved.recent.filter((id) => boardIds.has(id));
      const defaultBoardId = validRecent[0] ?? loaded[0]?.id ?? "";
      const openTabs = saved.tabsInitialized
        ? saved.openTabs.filter((id) => boardIds.has(id))
        : defaultBoardId ? [defaultBoardId] : [];
      const activeBoardId = openTabs.includes(saved.activeBoardId) ? saved.activeBoardId : openTabs[0] ?? "";
      setNavigationPreferences({ scope: navigationScope, value: { favorites: validFavorites, recent: validRecent, openTabs, activeBoardId, tabsInitialized: true } });
      setBoardId(activeBoardId);
      setBoardsReadyScope(navigationScope);
      setError(null);
    }).catch((reason) => live && setError(errorMessage(reason)));
    return () => { live = false; };
  }, [client, teamId, navigationScope]);

  const refreshBoard = useCallback(async () => {
    if (!client || !boardId) return;
    const request = ++boardRequest.current;
    const next = await client.taskBoard(boardId);
    if (request === boardRequest.current && currentBoardId.current === boardId && next.id === boardId) setBoard(next);
  }, [client, boardId]);

  const retryLoad = async () => {
    if (!client) return;
    const requestedTeamId = teamId;
    const requestedBoardId = boardId;
    setError(null);
    try {
      if (teamsError || !teams.length || !teamId) { await refreshTeams(); return; }
      const loaded = await client.teamBoards(teamId);
      if (currentTeamId.current !== requestedTeamId) return;
      setBoards(loaded);
      const validTabs = activeNavigationPreferences.openTabs.filter((id) => loaded.some((item) => item.id === id));
      const nextBoardId = validTabs.includes(boardId) ? boardId : validTabs.includes(activeNavigationPreferences.activeBoardId) ? activeNavigationPreferences.activeBoardId : "";
      setBoardId(nextBoardId);
      const nextBoard = nextBoardId ? await client.taskBoard(nextBoardId) : null;
      if (currentTeamId.current === requestedTeamId && (currentBoardId.current === requestedBoardId || currentBoardId.current === nextBoardId)) setBoard(nextBoard);
    } catch (reason) { setError(errorMessage(reason)); }
  };

  useEffect(() => {
    if (!client || !boardId) { boardRequest.current++; setBoard(null); setCursors([]); return; }
    boardRequest.current++;
    setCursors([]);
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (closed) return;
      try { socket = new WebSocket(client.taskRealtimeUrl(boardId)); }
      catch (reason) { setError(errorMessage(reason)); return; }
      socketRef.current = socket;
      socket.onmessage = (event) => {
        if (closed || currentBoardId.current !== boardId) return;
        try {
          const frame = JSON.parse(String(event.data)) as RealtimeFrame;
          if ((frame.type === "hello" || frame.type === "board") && frame.board.id === currentBoardId.current) setBoard(frame.board);
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
  const doMutation = async (action: () => Promise<unknown>, success?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try { await action(); if (success) toast.success(success); return true; }
    catch (reason) { setError(errorMessage(reason)); return false; }
    finally { setBusy(false); }
  };
  const updateNavigationPreferences = (update: (current: BoardNavigationPreferences) => BoardNavigationPreferences) => {
    if (!navigationScope) return;
    setNavigationPreferences((current) => ({
      scope: navigationScope,
      value: update(current.scope === navigationScope ? current.value : readBoardNavigationPreferences(navigationScope)),
    }));
  };
  const selectBoard = (nextBoardId: string) => {
    setError(null);
    setBoardPickerOpen(false);
    updateNavigationPreferences((current) => ({
      ...current,
      recent: [nextBoardId, ...current.recent.filter((id) => id !== nextBoardId)].slice(0, 12),
      openTabs: current.openTabs.includes(nextBoardId) ? current.openTabs : [...current.openTabs, nextBoardId],
      activeBoardId: nextBoardId,
      tabsInitialized: true,
    }));
    if (nextBoardId === boardId) return;
    setActiveCard(null);
    setAddingCardTo(null);
    setDraggingCardId(null); setDropTargetListId(null);
    setBoard(null);
    setCursors([]);
    setBoardId(nextBoardId);
  };
  const closeBoardTab = (closedId: string) => {
    const index = activeNavigationPreferences.openTabs.indexOf(closedId);
    const nextTabs = activeNavigationPreferences.openTabs.filter((id) => id !== closedId);
    const nextActive = boardId === closedId ? nextTabs[Math.min(index, nextTabs.length - 1)] ?? "" : boardId;
    updateNavigationPreferences((current) => ({ ...current, openTabs: nextTabs, activeBoardId: nextActive, tabsInitialized: true }));
    if (boardId === closedId) {
      setBoard(null); setCursors([]); setActiveCard(null); setAddingCardTo(null);
      setBoardId(nextActive);
    }
    setPendingTabFocus(nextActive);
  };
  const toggleFavorite = (favoriteBoardId: string) => updateNavigationPreferences((current) => ({
    ...current,
    favorites: current.favorites.includes(favoriteBoardId)
      ? current.favorites.filter((id) => id !== favoriteBoardId)
      : [favoriteBoardId, ...current.favorites],
  }));
  const changeTeam = (nextTeamId: string) => {
    if (nextTeamId === teamId) return;
    setActiveCard(null); setAddingCardTo(null);
    setDraggingCardId(null); setDropTargetListId(null);
    setBoards([]); setBoard(null); setBoardId(""); setCursors([]); selectActiveTeam(nextTeamId);
  };
  const pageError = error ?? teamsError;
  const onCreateTeam = async (event: FormEvent) => {
    event.preventDefault();
    if (!teamName.trim() || !client) return;
    if (await doMutation(async () => { const team = await client.createTeam(teamName); setTeamName(""); await refreshTeams(team.id); }, "Team created")) setDialog(null);
  };
  const onCreateBoard = async (event: FormEvent) => {
    event.preventDefault();
    if (!boardName.trim() || !client || !teamId) return;
    const requestedTeamId = teamId;
    if (await doMutation(async () => {
      const created = await client.createTaskBoard(requestedTeamId, boardName);
      if (currentTeamId.current !== requestedTeamId) return;
      setBoardName("");
      const loaded = await client.teamBoards(requestedTeamId);
      if (currentTeamId.current !== requestedTeamId) return;
      setBoards(loaded); selectBoard(created.id); setBoard(created);
    }, "Board created")) setDialog(null);
  };
  const onInvite = async (event: FormEvent) => {
    event.preventDefault();
    if (!inviteEmail.trim() || !client || !teamId) return;
    await doMutation(async () => { const invite = await client.createTeamInvitation(teamId, inviteEmail); setInviteToken(invite.token); }, "Invitation created");
  };
  const onAccept = async (event: FormEvent) => {
    event.preventDefault();
    if (!acceptToken.trim() || !client) return;
    if (await doMutation(async () => { const accepted = await client.acceptTeamInvitation(acceptToken.trim()); setAcceptToken(""); await refreshTeams(accepted.teamId); }, "You joined the team")) setDialog(null);
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
  const saveCard = async (card: TaskCard, input: { listId: string; title: string; description: string; position: number; assigneeId: string | null; dueAt: string | null }) => {
    if (!client || !boardId) return false;
    return doMutation(async () => {
      await client.saveTaskCard(boardId, card.id, input);
      await refreshBoard();
    }, "Card updated");
  };
  const moveCardToList = async (cardId: string, targetListId: string) => {
    const sourceList = board?.lists.find((list) => list.cards.some((card) => card.id === cardId));
    const source = sourceList?.cards.find((card) => card.id === cardId);
    const target = board?.lists.find((list) => list.id === targetListId);
    if (!source || !target || sourceList?.id === targetListId || !client || !boardId) return;
    const position = target.cards.reduce((max, card) => Math.max(max, card.position), -1) + 1;
    await doMutation(async () => {
      await client.saveTaskCard(boardId, source.id, { listId: target.id, title: source.title, description: source.description, position, assigneeId: source.assigneeId, dueAt: source.dueAt });
      await refreshBoard();
    }, "Card moved");
    setDraggingCardId(null); setDropTargetListId(null);
  };
  const requestCardDelete = (card: TaskCard) => {
    setPendingDelete({ title: `Delete “${card.title}”?`, description: "This permanently removes the card from the board.", action: async () => { await client?.deleteTaskCard(boardId, card.id); await refreshBoard(); setActiveCard((current) => current?.id === card.id ? null : current); } });
    setDeleteOpen(true);
  };
  const updateBoard = async (event: FormEvent) => {
    event.preventDefault();
    if (!board || !client) return;
    const title = boardName.trim();
    if (!title) return;
    if (await doMutation(async () => { await client.saveTaskBoard(board.id, title); await refreshBoard(); setBoardName(""); }, "Board renamed")) setDialog(null);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = boardSurface.current?.getBoundingClientRect();
    const socket = socketRef.current;
    if (!rect || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "cursor", x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }));
  };

  const cardCount = useMemo(() => visibleBoard?.lists.reduce((total, list) => total + list.cards.length, 0) ?? 0, [visibleBoard]);
  const onBoardTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => {
    const currentIndex = openedBoards.findIndex((item) => item.id === tabId);
    if (currentIndex < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? openedBoards.length - 1 : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + openedBoards.length) % openedBoards.length;
    const nextId = openedBoards[nextIndex]?.id;
    if (!nextId) return;
    selectBoard(nextId);
    requestAnimationFrame(() => boardTabRefs.current.get(nextId)?.focus());
  };
  if (teamsLoading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
      {titlebarSlot && createPortal(
        <div className="flex h-full min-w-0 items-center gap-1 overflow-hidden">
          <div ref={boardTabStripRef} className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="Boards">
            {openedBoards.map((item) => {
            const active = item.id === boardId;
            return <div key={item.id} role="presentation" className={`group flex h-7 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2.5 text-xs ${active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}>
              <Button ref={(node) => { if (node) boardTabRefs.current.set(item.id, node); else boardTabRefs.current.delete(item.id); }} type="button" role="tab" tabIndex={active ? 0 : -1} aria-selected={active} aria-controls="task-board-panel" id={`task-board-tab-${item.id}`} data-task-board-tab={item.id} title={item.title} variant="ghost" className="h-7 min-w-0 max-w-40 justify-start truncate px-0 text-xs" onClick={() => selectBoard(item.id)} onKeyDown={(event) => onBoardTabKeyDown(event, item.id)}>{item.title}</Button>
              <Button type="button" aria-label={`Close ${item.title} board tab`} title={`Close ${item.title}`} size="icon-xs" variant="ghost" className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => closeBoardTab(item.id)}><IconX className="size-3" /></Button>
            </div>;
          })}
          </div>
          <Button ref={pickerButtonRef} type="button" size="icon-sm" variant="ghost" className="size-7 shrink-0" aria-label="Open board" title="Open board (B)" onClick={() => setBoardPickerOpen(true)}><IconPlus /></Button>
        </div>,
        titlebarSlot,
      )}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5 sm:px-5">
            {teams.length > 0 && <Select value={teamId} onValueChange={changeTeam}>
              <SelectTrigger aria-label="Choose team" className="h-8 w-36 shrink-0 sm:w-48"><SelectValue placeholder="Choose team" /></SelectTrigger>
              <SelectContent avoidCollisions position="popper" className="w-[var(--radix-select-trigger-width)] min-w-0">
                {teams.map((team) => <SelectItem key={team.id} value={team.id} textValue={team.name}><span className="min-w-0 flex-1 truncate">{team.name}</span></SelectItem>)}
              </SelectContent>
            </Select>}
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold">Tasks</h1>
            </div>
            {selectedTeam && <div className="hidden items-center gap-2 sm:flex" aria-label="Team members">
              <AvatarGroup>{members.slice(0, 4).map((member) => {
                const name = member.name || member.email;
                const initials = name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
                return <Tooltip key={member.id}><TooltipTrigger asChild><Avatar size="sm" tabIndex={0} aria-label={name} className="focus-visible:ring-2 focus-visible:ring-ring"><AvatarFallback>{initials}</AvatarFallback></Avatar></TooltipTrigger><TooltipContent>{name}{member.role === "owner" ? " · owner" : ""}</TooltipContent></Tooltip>;
              })}{members.length > 4 && <Tooltip><TooltipTrigger asChild><AvatarGroupCount tabIndex={0} aria-label={members.length - 4 + " more team members"} className="focus-visible:ring-2 focus-visible:ring-ring">+{members.length - 4}</AvatarGroupCount></TooltipTrigger><TooltipContent>{members.slice(4).map((member) => (member.name || member.email) + (member.role === "owner" ? " · owner" : "")).join(", ")}</TooltipContent></Tooltip>}</AvatarGroup>
              <Badge variant="outline"><IconUsers />{members.length}</Badge>
            </div>}
            {visibleBoard && <Badge variant="secondary">{cardCount} {cardCount === 1 ? "card" : "cards"}</Badge>}
            <Button size="sm" onClick={() => { setError(null); setBoardName(""); setTeamName(""); setDialog(teams.length ? "board" : "team"); }}><IconPlus /><span className="hidden sm:inline">{teams.length ? "New board" : "Create team"}</span></Button>
            <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="outline" aria-label="Team and board actions"><IconDots /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => { setError(null); setTeamName(""); setDialog("team"); }}><IconPlus />Create team</DropdownMenuItem>
              {selectedTeam?.role === "owner" && <DropdownMenuItem onSelect={() => { setError(null); setInviteToken(""); setInviteEmail(""); setDialog("invite"); }}><IconUsers />Invite teammate</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => { setError(null); setDialog("join"); }}><IconArrowRight />Join with token</DropdownMenuItem>
              {visibleBoard && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => { setBoardName(visibleBoard.title); setError(null); setDialog("rename"); }}>Rename board</DropdownMenuItem>
                {selectedTeam?.role === "owner" && <DropdownMenuItem variant="destructive" onSelect={() => { setPendingDelete({ title: "Delete " + visibleBoard.title + "?", description: "This permanently deletes the board, its lists, and every card.", action: async () => { await client?.deleteTaskBoard(visibleBoard.id); const remaining = await client?.teamBoards(teamId) ?? []; const tabs = activeNavigationPreferences.openTabs.filter((id) => id !== visibleBoard.id && remaining.some((item) => item.id === id)); const nextActive = tabs[0] ?? ""; setNavigationPreferences((current) => ({ ...current, value: { ...current.value, openTabs: tabs, activeBoardId: nextActive, tabsInitialized: true } })); setBoards(remaining); setBoardId(nextActive); setBoard(null); } }); setDeleteOpen(true); }}>Delete board</DropdownMenuItem>}</>}
            </DropdownMenuContent></DropdownMenu>
          </header>

      <div id="task-board-panel" role="tabpanel" aria-labelledby={openedBoards.some((item) => item.id === boardId) ? `task-board-tab-${boardId}` : undefined} aria-label={visibleBoard?.title ?? "Task board"} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        {pageError && <div className="px-4 pt-3 sm:px-6"><ErrorBanner>{pageError}<Button className="ml-3 h-7" size="sm" variant="outline" onClick={() => void retryLoad()}>Retry</Button></ErrorBanner></div>}
        {!teams.length ? (
          <Empty className="m-auto max-w-lg border-0">
            <EmptyHeader><EmptyMedia variant="icon"><IconUsers /></EmptyMedia><EmptyTitle>Create a team to get started</EmptyTitle><EmptyDescription>Share task boards and invite people to work together.</EmptyDescription></EmptyHeader>
            <EmptyContent className="flex-row justify-center"><Button size="sm" onClick={() => setDialog("team")}><IconPlus />Create team</Button><Button size="sm" variant="outline" onClick={() => setDialog("join")}>Join with token</Button></EmptyContent>
          </Empty>
        ) : (
          <>
            {!visibleBoard ? (
                <Empty className="m-auto max-w-lg border-0"><EmptyHeader><EmptyMedia variant="icon"><IconChecklist /></EmptyMedia><EmptyTitle>{boards.length ? "Choose a board" : "No boards yet"}</EmptyTitle><EmptyDescription>{boards.length ? "Choose a board to see its lists and cards." : "Create a board for this team."}</EmptyDescription></EmptyHeader>{!boards.length && <EmptyContent><Button size="sm" onClick={() => setDialog("board")}><IconPlus />Create board</Button></EmptyContent>}</Empty>
            ) : (
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" ref={boardSurface} onPointerMove={onPointerMove}>
                {cursors.filter((cursor) => cursor.userId !== user?.id).map((cursor) => <div key={cursor.userId} className="pointer-events-none absolute z-20 transition-[left,top] duration-75" style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }} aria-hidden="true"><div className="flex items-center gap-1.5"><span className="size-3 rotate-[-25deg] rounded-sm rounded-bl-none bg-primary shadow" /><span className="rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground shadow">{cursor.name}</span></div></div>)}
                <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto overflow-y-hidden p-5" aria-label={`${visibleBoard.title} board`}>
                  {visibleBoard.lists.map((list) => <section key={list.id} className={`flex max-h-full w-[min(19rem,84vw)] shrink-0 flex-col rounded-xl border bg-muted/30 transition-colors ${dropTargetListId === list.id ? "border-primary bg-primary/5" : ""}`} aria-labelledby={`list-${list.id}`} onDragOver={(event) => { if (draggingCardId) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTargetListId(list.id); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTargetListId((current) => current === list.id ? null : current); }} onDrop={(event) => { event.preventDefault(); const cardId = event.dataTransfer.getData("text/plain") || draggingCardId; if (cardId) void moveCardToList(cardId, list.id); }}>
                    <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5"><h3 id={`list-${list.id}`} className="truncate text-sm font-semibold">{list.title}</h3><div className="flex items-center gap-1"><Badge variant="outline">{list.cards.length}</Badge><Button size="icon-xs" variant="ghost" aria-label={`Delete ${list.title} list`} onClick={() => { setPendingDelete({ title: `Delete “${list.title}”?`, description: `This removes the list and its ${list.cards.length} ${list.cards.length === 1 ? "card" : "cards"}.`, action: async () => { await client?.deleteTaskList(visibleBoard.id, list.id); await refreshBoard(); } }); setDeleteOpen(true); }}><IconTrash className="size-3 text-muted-foreground" /></Button></div></header>
                    <div className="min-h-10 space-y-2 overflow-y-auto p-2.5">
                      {list.cards.map((card) => <Card key={card.id} size="sm" className={`gap-0 rounded-lg p-2.5 py-2.5 shadow-sm transition-colors hover:bg-accent/40 ${draggingCardId === card.id ? "opacity-50" : ""}`}>
                        <Button type="button" variant="ghost" draggable aria-description="Drag to move this card, or open details and change its list with the keyboard." aria-label={"Open card: " + card.title} className="h-auto w-full cursor-grab flex-col items-stretch gap-2 whitespace-normal rounded-md p-0 text-left active:cursor-grabbing" onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", card.id); setDraggingCardId(card.id); }} onDragEnd={() => { setDraggingCardId(null); setDropTargetListId(null); }} onClick={() => setActiveCard(card)}>
                          <span className="text-sm font-medium leading-5">{card.title}</span>
                          {card.description && <span className="line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{card.description}</span>}
                          {(card.assigneeId || card.dueAt) && <span className="flex flex-wrap items-center gap-1.5">
                            {card.assigneeId && <Badge variant="outline" className="max-w-32 truncate">{members.find((item) => item.id === card.assigneeId)?.name || "Assigned"}</Badge>}
                            {card.dueAt && <Badge variant="secondary">Due {formatTaskDueDate(card.dueAt)}</Badge>}
                          </span>}
                        </Button>
                      </Card>)}                </div>
                    {addingCardTo === list.id ? <form className="space-y-2 border-t p-2.5" noValidate onSubmit={(event) => void onCreateCard(event, list.id)}>
                      <Label htmlFor={`card-title-${list.id}`}>Card title</Label><Input autoFocus id={`card-title-${list.id}`} maxLength={200} placeholder="What needs doing?" value={newCardTitle} onChange={(event) => setNewCardTitle(event.target.value)} />
                      <Label htmlFor={`card-description-${list.id}`}>Card details</Label><Textarea id={`card-description-${list.id}`} maxLength={5000} className="min-h-14 resize-none text-xs" placeholder="Add a note (optional)" value={newCardDescription} onChange={(event) => setNewCardDescription(event.target.value)} />
                      <div className="flex justify-end gap-1.5"><Button size="sm" variant="ghost" type="button" onClick={() => setAddingCardTo(null)}>Cancel</Button><Button size="sm" disabled={busy || !newCardTitle.trim()}>Add card</Button></div>
                    </form> : <Button className="m-2 mt-0 justify-start text-muted-foreground" size="sm" variant="ghost" onClick={() => setAddingCardTo(list.id)}><IconPlus />Add a card</Button>}
                  </section>)}
                  <form className="flex w-60 shrink-0 gap-1.5 rounded-xl border border-dashed p-2" noValidate onSubmit={onCreateList}><Label className="sr-only" htmlFor="new-list">New list name</Label><Input id="new-list" maxLength={80} placeholder="Add a list" value={listName} onChange={(event) => setListName(event.target.value)} /><Button size="icon-sm" variant="outline" aria-label="Create list" disabled={busy || !listName.trim()}><IconPlus /></Button></form>
                </div>
                <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (!busy) setDeleteOpen(open); }}>
                  <AlertDialogContent>
                    <AlertDialogHeader><AlertDialogTitle>{pendingDelete?.title}</AlertDialogTitle><AlertDialogDescription>{pendingDelete?.description}</AlertDialogDescription></AlertDialogHeader>
                    {error && <ErrorBanner>{error}</ErrorBanner>}
                    <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy} onClick={async (event) => { event.preventDefault(); if (pendingDelete && await doMutation(pendingDelete.action, "Deleted")) { setDeleteOpen(false); setPendingDelete(null); } }}>Delete</AlertDialogAction></AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </>
        )}
      </div>
        </main>
      <AppDialog open={boardPickerOpen} onOpenChange={setBoardPickerOpen} icon={<IconChecklist />} title="Open a board" description="Search your favorites, recent boards, or the full team list." size="md" className="sm:max-w-[480px]">
        <TaskBoardNavigator key={teamId} teams={teams} teamId={teamId} boards={boardsReadyScope === navigationScope ? boards : []} boardId={boardId} favorites={activeNavigationPreferences.favorites} recent={activeNavigationPreferences.recent} onTeamChange={changeTeam} onBoardChange={selectBoard} onFavoriteToggle={toggleFavorite} onCreateTeam={() => { setBoardPickerOpen(false); setDialog("team"); }} onCreateBoard={() => { setBoardPickerOpen(false); setBoardName(""); setDialog(teams.length ? "board" : "team"); }} showTeamSelector={false} className="h-[min(58dvh,28rem)]" />
      </AppDialog>
      <AppDialog open={dialog === "team"} onOpenChange={(open) => { if (!busy) setDialog(open ? "team" : null); }} icon={<IconUsers />} title="Create a team" description="Start a shared space for boards and teammates." footer={<><Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button form="create-team-form" disabled={busy || !teamName.trim()}><IconPlus />Create team</Button></>}>
        <form id="create-team-form" className="space-y-2" noValidate onSubmit={onCreateTeam}><Label htmlFor="new-team">Team name</Label><Input id="new-team" autoFocus maxLength={80} value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="e.g. Product" />{error && <ErrorBanner>{error}</ErrorBanner>}</form>
      </AppDialog>
      <AppDialog open={dialog === "board"} onOpenChange={(open) => { if (!busy) setDialog(open ? "board" : null); }} icon={<IconChecklist />} title="Create a board" description={`Add a board to ${selectedTeam?.name ?? "your team"}.`} footer={<><Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button form="create-board-form" disabled={busy || !boardName.trim()}><IconPlus />Create board</Button></>}>
        <form id="create-board-form" className="space-y-2" noValidate onSubmit={onCreateBoard}><Label htmlFor="new-board">Board name</Label><Input id="new-board" autoFocus maxLength={120} value={boardName} onChange={(event) => setBoardName(event.target.value)} placeholder="e.g. Product roadmap" />{error && <ErrorBanner>{error}</ErrorBanner>}</form>
      </AppDialog>
      <AppDialog open={dialog === "invite"} onOpenChange={(open) => { if (!busy) setDialog(open ? "invite" : null); }} icon={<IconUsers />} title="Invite a teammate" description={inviteToken ? `Invitation for ${inviteEmail}` : "Create a one-time invitation for a teammate."} footer={inviteToken ? undefined : <><Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button form="invite-form" disabled={busy || !inviteEmail.trim()}><IconUsers />Create invite</Button></>}>
        {inviteToken ? <div className="space-y-3"><p className="text-sm text-muted-foreground">Share the token below. New teammates choose “Join with an invitation” at sign-in; existing users paste it under Tasks → Join with token.</p><div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3"><code className="min-w-0 flex-1 break-all font-mono text-sm">{inviteToken}</code><Button size="icon-sm" variant="outline" aria-label="Copy invitation token" onClick={() => void copyText(inviteToken).then(() => toast.success("Invitation token copied")).catch(() => toast.error("Could not copy token"))}><IconCopy /></Button></div><Button variant="outline" onClick={() => { setInviteToken(""); setInviteEmail(""); setDialog(null); }}>Close</Button></div> : <form id="invite-form" className="space-y-2" noValidate onSubmit={onInvite}><Label htmlFor="invite-email">Teammate email</Label><Input id="invite-email" type="email" autoFocus maxLength={254} value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="name@example.com" />{error && <ErrorBanner>{error}</ErrorBanner>}</form>}
      </AppDialog>
      <AppDialog open={dialog === "join"} onOpenChange={(open) => { if (!busy) setDialog(open ? "join" : null); }} icon={<IconArrowRight />} title="Join a team" description="Paste the invitation token shared with you." footer={<><Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button form="join-team-form" disabled={busy || !acceptToken.trim()}>Join team</Button></>}>
        <form id="join-team-form" className="space-y-2" noValidate onSubmit={onAccept}><Label htmlFor="accept-invite">Invitation token</Label><Input id="accept-invite" autoFocus value={acceptToken} onChange={(event) => setAcceptToken(event.target.value)} placeholder="Paste invitation token" />{error && <ErrorBanner>{error}</ErrorBanner>}<p className="text-xs text-muted-foreground">Sign in with the email address the invitation was created for.</p></form>
      </AppDialog>
      <AppDialog open={dialog === "rename"} onOpenChange={(open) => { if (!busy) setDialog(open ? "rename" : null); }} title="Rename board" description="Choose a clear name for this board." footer={<><Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button form="rename-board-form" disabled={busy || !boardName.trim()}>Save name</Button></>}>
        <form id="rename-board-form" className="space-y-2" noValidate onSubmit={updateBoard}><Label htmlFor="rename-board">Board name</Label><Input id="rename-board" autoFocus maxLength={120} value={boardName} onChange={(event) => setBoardName(event.target.value)} />{error && <ErrorBanner>{error}</ErrorBanner>}</form>
      </AppDialog>
      {visibleBoard && <TaskCardDialog open={!!activeCard} onOpenChange={(open) => { if (!busy && !open) setActiveCard(null); }} board={visibleBoard} card={activeCard} members={members} busy={busy} error={error} onSave={saveCard} onDelete={requestCardDelete} />}
    </section>
  );
}
