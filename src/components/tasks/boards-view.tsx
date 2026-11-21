import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { IconArrowRight, IconChecklist, IconCopy, IconDots, IconPlus, IconTrash, IconUsers, IconX, IconStar } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingState } from "@/components/ui/spinner";
import { Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { AppDialog, ErrorBanner } from "@/components/ui/app-dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTitlebarSlot } from "@/lib/titlebar-slot";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { copyText } from "@/lib/clipboard";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { TaskBoard, TaskCard, TaskSourceInfo } from "@/lib/runtime/types";
import TaskCardDialog from "./task-card-dialog";
import { TaskSourcePanel } from "./external-task-list";
import { resolvePluginIcon } from "@/plugins/icons";
import { usePlugins } from "@/plugins/host";
import { closeSource, EMPTY_SOURCE_PREFS, openSource, readSourcePrefs, reconcileSourcePrefs, sourceGroups, sourceTabId, writeSourcePrefs, type SourcePrefs } from "@/lib/task-sources";

type Cursor = { userId: string; name: string; x: number; y: number };

function BoardSkeleton() {
  return <LoadingState label="Loading lists and cards…" aria-label="Loading task board" className="min-h-0 flex-1 p-5" />;
}
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

export default function BoardsView() {
  const { client, user, organizations, organizationsLoading, organizationsError, refreshOrganizations, activeOrganizationId, selectOrganization } = useRuntime();
  const organizationId = activeOrganizationId ?? "";
  const [boards, setBoards] = useState<Omit<TaskBoard, "lists">[]>([]);
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [boardId, setBoardId] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [boardQuery, setBoardQuery] = useState("");
  const boardSearchRef = useRef<HTMLInputElement>(null);
  const boardPickerTriggerRef = useRef<HTMLButtonElement>(null);
  const boardPickerReturnFocusRef = useRef<HTMLElement | null>(null);
  const boardPickerSelectedBoardRef = useRef<string | null>(null);
  const [cursors, setCursors] = useState<Cursor[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [organizationName, setOrganizationName] = useState("");
  const [boardName, setBoardName] = useState("");
  const [listName, setListName] = useState("");
  const [addingList, setAddingList] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [acceptToken, setAcceptToken] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ title: string; description: string; success: string; action: () => Promise<void> } | null>(null);
  const [dialog, setDialog] = useState<"organization" | "board" | "invite" | "join" | "rename" | null>(null);
  const [activeCard, setActiveCard] = useState<TaskCard | null>(null);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [dropTargetListId, setDropTargetListId] = useState<string | null>(null);
  const [navigationPreferences, setNavigationPreferences] = useState<{ scope: string; value: BoardNavigationPreferences }>({ scope: "", value: readBoardNavigationPreferences("") });
  const [boardsReadyScope, setBoardsReadyScope] = useState("");
  // Task sources contributed by plugins: their tabs persist next to board tabs and are validated against GET /v1/task-sources.
  const [sources, setSources] = useState<TaskSourceInfo[]>([]);
  // Re-read the source list whenever a plugin is turned on or off (or its secrets change status), so groups and tabs appear and go away live.
  const pluginsSignature = usePlugins().all.map((p) => `${p.id}:${p.status}:${p.userEnabled}:${p.secrets.map((x) => (x.present ? 1 : 0)).join("")}`).join("|");
  const [sourcePrefs, setSourcePrefs] = useState<{ scope: string; value: SourcePrefs; ready: boolean }>({ scope: "", value: EMPTY_SOURCE_PREFS, ready: false });
  const [addingCardTo, setAddingCardTo] = useState<string | null>(null);
  const [newCardTitle, setNewCardTitle] = useState("");
  const [newCardDescription, setNewCardDescription] = useState("");
  const boardSurface = useRef<HTMLDivElement>(null);
  const boardTabStripRef = useRef<HTMLDivElement>(null);
  const boardTabRefs = useRef(new Map<string, HTMLButtonElement>());
  const titlebarSlot = useTitlebarSlot();
  const socketRef = useRef<WebSocket | null>(null);
  const boardRequest = useRef(0);
  const currentBoardId = useRef(boardId);
  currentBoardId.current = boardId;
  const currentOrganizationId = useRef(organizationId);
  currentOrganizationId.current = organizationId;
  const navigationScope = client && user && organizationId
    ? `floq.tasks.navigation.v1:${encodeURIComponent(client.baseUrl)}:${encodeURIComponent(user.id)}:${encodeURIComponent(organizationId)}`
    : "";
  const sourceScope = navigationScope ? navigationScope + ":sources" : "";
  const activeSourcePrefs = sourcePrefs.scope === sourceScope && sourcePrefs.ready ? sourcePrefs.value : EMPTY_SOURCE_PREFS;
  const openedSources = activeSourcePrefs.open.flatMap((id) => sources.find((item) => sourceTabId(item) === id) ?? []);
  const activeSource = sources.find((item) => sourceTabId(item) === activeSourcePrefs.active) ?? null;
  const activeNavigationPreferences = navigationPreferences.scope === navigationScope ? navigationPreferences.value : readBoardNavigationPreferences("");
  const selectedOrganization = organizations.find((organization) => organization.id === organizationId) ?? null;
  const visibleBoard = boardsReadyScope === navigationScope && board?.organizationId === organizationId ? board : null;
  const openedBoards = boardsReadyScope === navigationScope ? activeNavigationPreferences.openTabs.flatMap((id) => boards.find((item) => item.id === id) ?? []) : [];

  const openBoardPicker = (trigger?: HTMLElement | null) => {
    const activeElement = document.activeElement;
    boardPickerReturnFocusRef.current = trigger
      ?? (activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : null)
      ?? boardPickerTriggerRef.current;
    boardPickerSelectedBoardRef.current = null;
    setPickerOpen(true);
  };
  const restoreBoardPickerFocus = (event: Event) => {
    event.preventDefault();
    const selectedBoardId = boardPickerSelectedBoardRef.current;
    const opener = boardPickerReturnFocusRef.current;
    const fallback = boardPickerTriggerRef.current;
    requestAnimationFrame(() => {
      if (selectedBoardId) {
        boardTabRefs.current.get(selectedBoardId)?.focus();
      } else {
        const target = opener?.isConnected && opener.getClientRects().length > 0
          ? opener
          : fallback?.isConnected && fallback.getClientRects().length > 0 ? fallback : null;
        target?.focus();
      }
      boardPickerReturnFocusRef.current = null;
      boardPickerSelectedBoardRef.current = null;
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== "b") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="combobox"]')) return;
      event.preventDefault();
      openBoardPicker();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    if (!client || !organizationId) { setBoards([]); setBoard(null); setBoardId(""); return; }
    let live = true;
    setBoards([]); setBoard(null); setBoardId(""); setCursors([]); setActiveCard(null); setAddingCardTo(null); setDraggingCardId(null); setDropTargetListId(null);
    client.organizationBoards(organizationId).then((loaded) => {
      if (!live) return;
      setBoards(loaded);
      const boardIds = new Set(loaded.map((item) => item.id));
      const saved = readBoardNavigationPreferences(navigationScope);
      const validFavorites = saved.favorites.filter((id) => boardIds.has(id));
      const validRecent = saved.recent.filter((id) => boardIds.has(id));
      const defaultBoardId = validRecent[0] ?? loaded[0]?.id ?? "";
      const openTabs = saved.tabsInitialized ? saved.openTabs.filter((id) => boardIds.has(id)) : defaultBoardId ? [defaultBoardId] : [];
      const activeBoardId = openTabs.includes(saved.activeBoardId) ? saved.activeBoardId : openTabs[0] ?? "";
      setNavigationPreferences({ scope: navigationScope, value: { favorites: validFavorites, recent: validRecent, openTabs, activeBoardId, tabsInitialized: true } });
      setBoardId(activeBoardId);
      setBoardsReadyScope(navigationScope);
      setError(null);
    }).catch((reason) => live && setError(errorMessage(reason)));
    return () => { live = false; };
  }, [client, organizationId, navigationScope]);

  useEffect(() => {
    if (!client || !sourceScope) { setSources([]); setSourcePrefs({ scope: sourceScope, value: EMPTY_SOURCE_PREFS, ready: false }); return; }
    let live = true;
    client.taskSources().catch(() => [] as TaskSourceInfo[]).then((available) => {
      if (!live) return;
      setSources(available);
      setSourcePrefs({ scope: sourceScope, value: reconcileSourcePrefs(readSourcePrefs(sourceScope), available), ready: true });
    });
    return () => { live = false; };
  }, [client, sourceScope, pluginsSignature]);

  useEffect(() => {
    if (sourcePrefs.scope === sourceScope && sourcePrefs.ready) writeSourcePrefs(sourceScope, sourcePrefs.value);
  }, [sourceScope, sourcePrefs]);

  const updateSourcePrefs = (update: (current: SourcePrefs) => SourcePrefs) => setSourcePrefs((current) => ({ scope: sourceScope, ready: true, value: update(current.scope === sourceScope ? current.value : EMPTY_SOURCE_PREFS) }));
  const openSourceTab = (item: TaskSourceInfo) => { setError(null); updateSourcePrefs((current) => openSource(current, sourceTabId(item))); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-task-source-tab="${CSS.escape(sourceTabId(item))}"]`)?.focus()); };
  const closeSourceTab = (id: string) => {
    updateSourcePrefs((current) => closeSource(current, id));
    requestAnimationFrame(() => (boardId ? boardTabRefs.current.get(boardId) : boardPickerTriggerRef.current)?.focus());
  };

  const refreshBoard = useCallback(async () => {
    if (!client || !boardId) return;
    const request = ++boardRequest.current;
    const next = await client.taskBoard(boardId);
    if (request === boardRequest.current && currentBoardId.current === boardId && next.id === boardId) setBoard(next);
  }, [client, boardId]);

  const retryLoad = async () => {
    if (!client) return;
    const requestedOrganizationId = organizationId;
    const requestedBoardId = boardId;
    setError(null);
    try {
      if (organizationsError || !organizations.length || !organizationId) { await refreshOrganizations(); return; }
      const loaded = await client.organizationBoards(organizationId);
      if (currentOrganizationId.current !== requestedOrganizationId) return;
      setBoards(loaded);
      const validIds = loaded.map((item) => item.id);
      const nextBoardId = validIds.includes(boardId) ? boardId : validIds.includes(activeNavigationPreferences.activeBoardId) ? activeNavigationPreferences.activeBoardId : validIds[0] ?? "";
      setBoardId(nextBoardId);
      const nextBoard = nextBoardId ? await client.taskBoard(nextBoardId) : null;
      if (currentOrganizationId.current === requestedOrganizationId && (currentBoardId.current === requestedBoardId || currentBoardId.current === nextBoardId)) setBoard(nextBoard);
    } catch (reason) { setError(errorMessage(reason)); }
  };

  useEffect(() => {
    if (!client || !boardId) { boardRequest.current++; setBoard(null); setCursors([]); return; }
    const request = ++boardRequest.current;
    setCursors([]);
    let closed = false;
    // Render a snapshot even when the live connection is temporarily unavailable.
    void client.taskBoard(boardId).then((next) => {
      if (!closed && request === boardRequest.current && currentBoardId.current === boardId) setBoard(next);
    }).catch((reason) => {
      if (!closed && request === boardRequest.current) setError(errorMessage(reason));
    });
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
          if ((frame.type === "hello" || frame.type === "board") && frame.board.id === currentBoardId.current) { boardRequest.current++; setBoard(frame.board); setError(null); }
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

  const members = selectedOrganization?.members ?? [];
  const SUCCESS_HINTS: Record<string, string> = {
    "Organization created": "You are its first member and can invite others.",
    "Board created": "It is open now. Add lists to start planning.",
    "Invitation created": "Share the token shown in the dialog with the new member.",
    "You joined the organization": "Its boards are now available to you.",
    "List created": "Add cards to it to start tracking work.",
    "Card created": "It was added to the end of the list.",
    "Card updated": "Your changes are saved.",
    "Card moved": "It now sits at the end of the new list.",
    "Board renamed": "The new name shows for everyone in the organization.",
    "Card deleted": "It was removed from the board.",
    "List deleted": "Its cards were removed too.",
    "Board deleted": "Its lists and cards were removed too.",
  };
  const doMutation = async (action: () => Promise<unknown>, success?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try { await action(); if (success) toast.success(success, { description: SUCCESS_HINTS[success] ?? "The change is saved." }); return true; }
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
    updateSourcePrefs((current) => (current.active ? { ...current, active: "" } : current));
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
  const pageError = error ?? organizationsError;
  const closeBoardTab = (id: string) => {
    const tabs = activeNavigationPreferences.openTabs.filter((tab) => tab !== id);
    const index = activeNavigationPreferences.openTabs.indexOf(id);
    const nextId = boardId === id ? tabs[Math.min(index, tabs.length - 1)] ?? "" : boardId;
    updateNavigationPreferences((current) => ({ ...current, openTabs: tabs, activeBoardId: nextId, tabsInitialized: true }));
    if (boardId === id) { setBoardId(nextId); setBoard(null); setActiveCard(null); }
    requestAnimationFrame(() => (nextId ? boardTabRefs.current.get(nextId) : boardPickerTriggerRef.current)?.focus());
  };
  const favoriteIds = new Set(activeNavigationPreferences.favorites);
  const recentIds = new Set(activeNavigationPreferences.recent);
  const pickerGroups = boardQuery.trim()
    ? [{ title: "Search results", items: boards.filter((item) => item.title.toLocaleLowerCase().includes(boardQuery.trim().toLocaleLowerCase())) }]
    : [
      { title: "Favorites", items: boards.filter((item) => favoriteIds.has(item.id)) },
      { title: "Recent", items: activeNavigationPreferences.recent.flatMap((id) => boards.find((item) => item.id === id && !favoriteIds.has(id)) ?? []) },
      { title: "All boards", items: boards.filter((item) => !favoriteIds.has(item.id) && !recentIds.has(item.id)) },
    ];
  const onCreateOrganization = async (event: FormEvent) => {
    event.preventDefault();
    if (!organizationName.trim() || !client) return;
    if (await doMutation(async () => { const organization = await client.createOrganization(organizationName); setOrganizationName(""); await refreshOrganizations(organization.id); }, "Organization created")) setDialog(null);
  };
  const onCreateBoard = async (event: FormEvent) => {
    event.preventDefault();
    if (!boardName.trim() || !client || !organizationId) return;
    const requestedOrganizationId = organizationId;
    if (await doMutation(async () => {
      const created = await client.createTaskBoard(requestedOrganizationId, boardName);
      if (currentOrganizationId.current !== requestedOrganizationId) return;
      setBoardName("");
      const loaded = await client.organizationBoards(requestedOrganizationId);
      if (currentOrganizationId.current !== requestedOrganizationId) return;
      setBoards(loaded); selectBoard(created.id); setBoard(created);
    }, "Board created")) setDialog(null);
  };
  const onInvite = async (event: FormEvent) => {
    event.preventDefault();
    if (!inviteEmail.trim() || !client || !organizationId) return;
    await doMutation(async () => { const invite = await client.createOrganizationInvitation(organizationId, inviteEmail); setInviteToken(invite.token); }, "Invitation created");
  };
  const onAccept = async (event: FormEvent) => {
    event.preventDefault();
    if (!acceptToken.trim() || !client) return;
    if (await doMutation(async () => { const accepted = await client.acceptOrganizationInvitation(acceptToken.trim()); setAcceptToken(""); await refreshOrganizations(accepted.organizationId); }, "You joined the organization")) setDialog(null);
  };
  const onCreateList = async (event: FormEvent) => {
    event.preventDefault();
    if (!boardId || !client || !listName.trim()) return;
    await doMutation(async () => { await client.createTaskList(boardId, listName); setListName(""); setAddingList(false); await refreshBoard(); }, "List created");
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
    setPendingDelete({ title: `Delete “${card.title}”?`, description: "This permanently removes the card from the board.", success: "Card deleted", action: async () => { await client?.deleteTaskCard(boardId, card.id); await refreshBoard(); setActiveCard((current) => current?.id === card.id ? null : current); } });
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
  // Arrow keys, Home and End move across board tabs and source tabs as one strip (docs/DESIGN.md "Project navigation").
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, key: string) => {
    const tabs = [...openedBoards.map((item) => "b:" + item.id), ...openedSources.map((item) => "s:" + sourceTabId(item))];
    const currentIndex = tabs.indexOf(key);
    if (currentIndex < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    const id = next.slice(2);
    if (next.startsWith("b:")) { selectBoard(id); requestAnimationFrame(() => boardTabRefs.current.get(id)?.focus()); }
    else { updateSourcePrefs((current) => openSource(current, id)); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-task-source-tab="${CSS.escape(id)}"]`)?.focus()); }
  };
  if (organizationsLoading) return <section className="flex h-full min-h-0 flex-col"><header className="flex h-[53px] shrink-0 items-center justify-between gap-4 border-b px-4 sm:px-8"><h2 className="text-base font-semibold">Boards</h2><Skeleton rows={1} className="h-7 w-24 rounded-lg" /></header><BoardSkeleton /></section>;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col text-foreground">
      {titlebarSlot && createPortal(
        <div className="flex h-full min-w-0 items-center gap-1 overflow-hidden">
          <div ref={boardTabStripRef} className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="Boards">
            {openedBoards.map((item) => {
            const active = item.id === boardId && !activeSource;
            return <div key={item.id} role="presentation" className={`group flex h-7 shrink-0 items-center rounded-md px-2.5 text-xs ${active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}>
              <Button ref={(node) => { if (node) boardTabRefs.current.set(item.id, node); else boardTabRefs.current.delete(item.id); }} type="button" role="tab" tabIndex={active ? 0 : -1} aria-selected={active} aria-controls="task-board-panel" id={`task-board-tab-${item.id}`} data-task-board-tab={item.id} title={item.title} variant="ghost" className="h-7 min-w-0 max-w-40 justify-start truncate px-0 text-xs" onClick={() => selectBoard(item.id)} onKeyDown={(event) => onTabKeyDown(event, "b:" + item.id)}>{item.title}</Button>
              <Button variant="ghost" size="icon-xs" className="ml-1 size-5" aria-label={`Close ${item.title} tab`} onClick={() => closeBoardTab(item.id)}><IconX className="size-3" /></Button>
            </div>;
          })}
            {openedSources.map((item) => {
              const id = sourceTabId(item);
              const active = activeSource ? sourceTabId(activeSource) === id : false;
              const Icon = resolvePluginIcon(item.icon);
              return <div key={id} role="presentation" className={`group flex h-7 shrink-0 items-center rounded-md px-2.5 text-xs ${active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}>
                <Button type="button" role="tab" tabIndex={active ? 0 : -1} aria-selected={active} aria-controls="task-board-panel" id={`task-source-tab-${id}`} data-task-source-tab={id} title={item.label} variant="ghost" className="h-7 min-w-0 max-w-40 justify-start gap-1 truncate px-0 text-xs" onClick={() => updateSourcePrefs((current) => openSource(current, id))} onKeyDown={(event) => onTabKeyDown(event, "s:" + id)}><Icon className="size-3.5 shrink-0" /><span className="truncate">{item.label}</span></Button>
                <Button variant="ghost" size="icon-xs" className="ml-1 size-5" aria-label={`Close ${item.label} tab`} onClick={() => closeSourceTab(id)}><IconX className="size-3" /></Button>
              </div>;
            })}
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Choose a board" title="Choose a board (B)" onClick={(event) => openBoardPicker(event.currentTarget)}><IconPlus /></Button>
        </div>,
        titlebarSlot,
      )}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5 sm:px-8">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-semibold">Boards{selectedOrganization && <span className="ml-2 font-normal text-muted-foreground">{selectedOrganization.name}</span>}</h2>
            </div>
            {organizations.length > 0 && <Button ref={boardPickerTriggerRef} variant="outline" size="sm" aria-label="Choose a board" onClick={(event) => openBoardPicker(event.currentTarget)}><IconChecklist /><span className="hidden sm:inline">Boards</span></Button>}
            {selectedOrganization && <div className="hidden items-center gap-2 sm:flex" role="group" aria-label="Organization members">
              <AvatarGroup>{members.slice(0, 4).map((member) => {
                const name = member.name || member.email;
                const initials = name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
                return <Tooltip key={member.id}><TooltipTrigger asChild><Avatar size="sm" role="img" tabIndex={0} aria-label={name} className="focus-visible:ring-2 focus-visible:ring-ring"><AvatarFallback>{initials}</AvatarFallback></Avatar></TooltipTrigger><TooltipContent>{name}{member.role === "owner" ? " · owner" : ""}</TooltipContent></Tooltip>;
              })}{members.length > 4 && <Tooltip><TooltipTrigger asChild><AvatarGroupCount role="img" tabIndex={0} aria-label={members.length - 4 + " more organization members"} className="focus-visible:ring-2 focus-visible:ring-ring">+{members.length - 4}</AvatarGroupCount></TooltipTrigger><TooltipContent>{members.slice(4).map((member) => (member.name || member.email) + (member.role === "owner" ? " · owner" : "")).join(", ")}</TooltipContent></Tooltip>}</AvatarGroup>
              <Badge variant="outline"><IconUsers />{members.length}</Badge>
            </div>}
            {visibleBoard && <Badge variant="secondary">{cardCount} {cardCount === 1 ? "card" : "cards"}</Badge>}
            <Button size="sm" shimmer aria-label={organizations.length ? "New board" : "Create organization"} onClick={() => { setError(null); setBoardName(""); setOrganizationName(""); setDialog(organizations.length ? "board" : "organization"); }}><IconPlus /><span className="hidden sm:inline">{organizations.length ? "New board" : "Create organization"}</span></Button>
            <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="outline" aria-label="Organization and board actions"><IconDots /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => { setError(null); setOrganizationName(""); setDialog("organization"); }}><IconPlus />Create organization</DropdownMenuItem>
              {selectedOrganization?.role === "owner" && <DropdownMenuItem onSelect={() => { setError(null); setInviteToken(""); setInviteEmail(""); setDialog("invite"); }}><IconUsers />Invite member</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => { setError(null); setDialog("join"); }}><IconArrowRight />Join with token</DropdownMenuItem>
              {visibleBoard && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => updateNavigationPreferences((current) => ({ ...current, favorites: current.favorites.includes(visibleBoard.id) ? current.favorites.filter((id) => id !== visibleBoard.id) : [...current.favorites, visibleBoard.id] }))}><IconStar />{favoriteIds.has(visibleBoard.id) ? "Remove from favorites" : "Add to favorites"}</DropdownMenuItem><DropdownMenuItem onSelect={() => { setBoardName(visibleBoard.title); setError(null); setDialog("rename"); }}>Rename board</DropdownMenuItem>
                {selectedOrganization?.role === "owner" && <DropdownMenuItem variant="destructive" onSelect={() => { setPendingDelete({ title: "Delete " + visibleBoard.title + "?", description: "This permanently deletes the board, its lists, and every card.", success: "Board deleted", action: async () => { await client?.deleteTaskBoard(visibleBoard.id); const remaining = await client?.organizationBoards(organizationId) ?? []; const available = new Set(remaining.map((item) => item.id)); const tabs = activeNavigationPreferences.openTabs.filter((id) => available.has(id)); const nextActive = tabs[0] ?? ""; setNavigationPreferences((current) => ({ ...current, value: { ...current.value, openTabs: tabs, activeBoardId: nextActive, tabsInitialized: true } })); setBoards(remaining); setBoardId(nextActive); setBoard(null); } }); setDeleteOpen(true); }}>Delete board</DropdownMenuItem>}</>}
            </DropdownMenuContent></DropdownMenu>
          </header>

      <div id="task-board-panel" role="tabpanel" aria-labelledby={activeSource ? `task-source-tab-${sourceTabId(activeSource)}` : openedBoards.some((item) => item.id === boardId) ? `task-board-tab-${boardId}` : undefined} aria-label={activeSource?.label ?? visibleBoard?.title ?? "Task board"} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        {activeSource ? <TaskSourcePanel source={activeSource} /> : <>
        {pageError && <div className="px-4 pt-3 sm:px-6"><ErrorBanner>{pageError}<Button className="ml-3 h-7" size="sm" variant="outline" onClick={() => void retryLoad()}>Retry</Button></ErrorBanner></div>}
        {!organizations.length ? (
          <Empty className="m-auto max-w-lg border-0">
            <EmptyHeader><EmptyMedia variant="icon"><IconUsers /></EmptyMedia><EmptyTitle>Create an organization to get started</EmptyTitle><EmptyDescription>Share task boards and invite people to work together.</EmptyDescription></EmptyHeader>
            <EmptyContent className="flex-row justify-center"><Button size="sm" onClick={() => setDialog("organization")}><IconPlus />Create organization</Button><Button size="sm" variant="outline" onClick={() => setDialog("join")}>Join with token</Button></EmptyContent>
          </Empty>
        ) : (
          <>
            {!visibleBoard && (boardId || boardsReadyScope !== navigationScope) && !pageError ? <BoardSkeleton /> : !visibleBoard ? (
                <Empty className="m-auto max-w-lg border-0 bg-transparent"><EmptyHeader><EmptyMedia variant="icon"><IconChecklist /></EmptyMedia><EmptyTitle>{boards.length ? "Choose a board" : "No boards yet"}</EmptyTitle><EmptyDescription>{boards.length ? "Choose a board to see its lists and cards." : "Create a board for this organization."}</EmptyDescription></EmptyHeader><EmptyContent>{boards.length ? <Button size="sm" variant="outline" onClick={(event) => openBoardPicker(event.currentTarget)}>Choose a board</Button> : <Button size="sm" onClick={() => setDialog("board")}><IconPlus />Create board</Button>}</EmptyContent></Empty>
            ) : (
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" ref={boardSurface} onPointerMove={onPointerMove}>
                {cursors.filter((cursor) => cursor.userId !== user?.id).map((cursor) => <div key={cursor.userId} className="pointer-events-none absolute z-20 transition-[left,top] duration-75" style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }} aria-hidden="true"><div className="flex items-center gap-1.5"><span className="size-3 rotate-[-25deg] rounded-sm rounded-bl-none bg-primary shadow" /><span className="rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground shadow">{cursor.name}</span></div></div>)}
                <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto overflow-y-hidden px-4 py-5 sm:px-8" role="region" aria-label={`${visibleBoard.title} board`}>
                  {visibleBoard.lists.map((list) => <section key={list.id} data-drop={dropTargetListId === list.id || undefined} className="tasks-column flex max-h-full w-[min(19rem,84vw)] shrink-0 flex-col rounded-2xl" aria-labelledby={`list-${list.id}`} onDragOver={(event) => { if (draggingCardId) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTargetListId(list.id); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTargetListId((current) => current === list.id ? null : current); }} onDrop={(event) => { event.preventDefault(); const cardId = event.dataTransfer.getData("text/plain") || draggingCardId; if (cardId) void moveCardToList(cardId, list.id); }}>
                    <header className="tasks-column-head flex h-11 items-center justify-between gap-2 px-3.5"><h3 id={`list-${list.id}`} className="truncate text-sm font-medium">{list.title}</h3><div className="flex items-center gap-1"><Badge variant="outline">{list.cards.length}</Badge><Button size="icon-xs" variant="ghost" aria-label={`Delete ${list.title} list`} onClick={() => { setPendingDelete({ title: `Delete “${list.title}”?`, description: `This removes the list and its ${list.cards.length} ${list.cards.length === 1 ? "card" : "cards"}.`, success: "List deleted", action: async () => { await client?.deleteTaskList(visibleBoard.id, list.id); await refreshBoard(); } }); setDeleteOpen(true); }}><IconTrash className="size-3 text-muted-foreground" /></Button></div></header>
                    <div className="min-h-10 space-y-2 overflow-y-auto p-2.5">
                      {list.cards.map((card) => <Card key={card.id} size="sm" data-dragging={draggingCardId === card.id || undefined} className="tasks-card gap-0 rounded-xl p-3 py-3 ring-0">
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
                  {addingList
                    ? <form className="tasks-column w-[min(19rem,84vw)] shrink-0 space-y-2 self-start rounded-2xl p-2.5" noValidate onSubmit={onCreateList}>
                      <Label className="sr-only" htmlFor="new-list">New list name</Label><Input autoFocus id="new-list" maxLength={80} placeholder="List name" value={listName} onChange={(event) => setListName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setAddingList(false); setListName(""); } }} />
                      <div className="flex justify-end gap-1.5"><Button size="sm" variant="ghost" type="button" onClick={() => { setAddingList(false); setListName(""); }}>Cancel</Button><Button size="sm" disabled={busy || !listName.trim()}>Add list</Button></div>
                    </form>
                    : <Button className="h-11 w-[min(19rem,84vw)] shrink-0 justify-start self-start rounded-2xl border border-dashed text-muted-foreground" size="sm" variant="ghost" onClick={() => setAddingList(true)}><IconPlus />Add a list</Button>}
                </div>
                <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (!busy) setDeleteOpen(open); }}>
                  <AlertDialogContent>
                    <AlertDialogHeader><AlertDialogTitle>{pendingDelete?.title}</AlertDialogTitle><AlertDialogDescription>{pendingDelete?.description}</AlertDialogDescription></AlertDialogHeader>
                    {error && <ErrorBanner>{error}</ErrorBanner>}
                    <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy} onClick={async (event) => { event.preventDefault(); if (pendingDelete && await doMutation(pendingDelete.action, pendingDelete.success)) { setDeleteOpen(false); setPendingDelete(null); } }}>Delete</AlertDialogAction></AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </>
        )}
        </>}
      </div>
        </main>
      <CommandDialog open={pickerOpen} onOpenChange={(open) => { setPickerOpen(open); if (!open) setBoardQuery(""); }} onCloseAutoFocus={restoreBoardPickerFocus} title="Choose a board" description="Search boards in your organization. Select a board to open its tab.">
        <div className="border-b p-3">
          <Label htmlFor="board-organization" className="mb-2 block text-xs text-muted-foreground">Organization</Label>
          <Select value={organizationId} onValueChange={selectOrganization}>
            <SelectTrigger id="board-organization" className="w-full"><SelectValue placeholder="Choose organization" /></SelectTrigger>
            <SelectContent>{organizations.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Command shouldFilter={false}>
          <div className="relative">
            <CommandInput ref={boardSearchRef} value={boardQuery} onValueChange={setBoardQuery} placeholder="Search boards…" aria-label="Search boards" className="pr-9" />
            {boardQuery && <Button variant="ghost" size="icon-xs" aria-label="Clear board search" className="absolute top-1.5 right-2" onClick={() => { setBoardQuery(""); boardSearchRef.current?.focus(); }}><IconX /></Button>}
          </div>
          <CommandList className="max-h-[min(320px,45dvh)]">
            <CommandEmpty>{boardsReadyScope !== navigationScope && organizationId ? "Loading boards…" : boardQuery ? "No boards match your search." : "No boards in this organization."}</CommandEmpty>
            {pickerGroups.filter((group) => group.items.length > 0).map((group) => <CommandGroup key={group.title} heading={group.title}>
              {group.items.map((item) => <CommandItem key={item.id} value={item.id} className="min-w-0" onSelect={() => { boardPickerSelectedBoardRef.current = item.id; selectBoard(item.id); setPickerOpen(false); setBoardQuery(""); }}><IconChecklist /><span className="truncate">{item.title}</span>{favoriteIds.has(item.id) && <IconStar aria-hidden="true" className="ml-auto size-3 fill-primary text-primary-text" />}{item.id === boardId && <span className="ml-auto text-xs text-muted-foreground">Open</span>}</CommandItem>)}
            </CommandGroup>)}
            {/* One group per source. Only the source entries are filtered by the query: external items are never mixed into board results. */}
            {sourceGroups(sources, boardQuery).map((group) => <CommandGroup key={sourceTabId(group.source)} heading={group.title}>
              <CommandItem value={"source:" + sourceTabId(group.source)} className="min-w-0" onSelect={() => { openSourceTab(group.source); setPickerOpen(false); setBoardQuery(""); }}>{(() => { const Icon = resolvePluginIcon(group.source.icon); return <Icon />; })()}<span className="truncate">Open {group.source.label}</span></CommandItem>
            </CommandGroup>)}
          </CommandList>
        </Command>
      </CommandDialog>
      <AppDialog open={dialog === "organization"} onOpenChange={(open) => { if (!busy) setDialog(open ? "organization" : null); }} icon={<IconUsers />} title="Create an organization" description="Start a shared space for boards and members." footer={<><Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button form="create-organization-form" disabled={busy || !organizationName.trim()}><IconPlus />Create organization</Button></>}>
        <form id="create-organization-form" className="space-y-2" noValidate onSubmit={onCreateOrganization}><Label htmlFor="new-organization">Organization name</Label><Input id="new-organization" autoFocus maxLength={80} value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} placeholder="e.g. Product" />{error && <ErrorBanner>{error}</ErrorBanner>}</form>
      </AppDialog>
      <AppDialog open={dialog === "board"} onOpenChange={(open) => { if (!busy) setDialog(open ? "board" : null); }} icon={<IconChecklist />} title="Create a board" description={`Add a board to ${selectedOrganization?.name ?? "your organization"}.`} footer={<><Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button form="create-board-form" disabled={busy || !boardName.trim()}><IconPlus />Create board</Button></>}>
        <form id="create-board-form" className="space-y-2" noValidate onSubmit={onCreateBoard}><Label htmlFor="new-board">Board name</Label><Input id="new-board" autoFocus maxLength={120} value={boardName} onChange={(event) => setBoardName(event.target.value)} placeholder="e.g. Product roadmap" />{error && <ErrorBanner>{error}</ErrorBanner>}</form>
      </AppDialog>
      <AppDialog open={dialog === "invite"} onOpenChange={(open) => { if (!busy) setDialog(open ? "invite" : null); }} icon={<IconUsers />} title="Invite a member" description={inviteToken ? `Invitation for ${inviteEmail}` : "Create a one-time invitation for a member."} footer={inviteToken ? undefined : <><Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button form="invite-form" disabled={busy || !inviteEmail.trim()}><IconUsers />Create invite</Button></>}>
        {inviteToken ? <div className="space-y-3"><p className="text-sm text-muted-foreground">Share the token below. New members choose “Join with an invitation” at sign-in; existing users paste it under Tasks → Join with token.</p><div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3"><code className="min-w-0 flex-1 break-all font-mono text-sm">{inviteToken}</code><Button size="icon-sm" variant="outline" aria-label="Copy invitation token" onClick={() => void copyText(inviteToken).then(() => toast.success("Invitation token copied", { description: "Send it to the new member over a private channel." })).catch(() => toast.error("Could not copy token", { description: "Select the token and copy it by hand." }))}><IconCopy /></Button></div><Button variant="outline" onClick={() => { setInviteToken(""); setInviteEmail(""); setDialog(null); }}>Close</Button></div> : <form id="invite-form" className="space-y-2" noValidate onSubmit={onInvite}><Label htmlFor="invite-email">Member email</Label><Input id="invite-email" type="email" autoFocus maxLength={254} value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="name@example.com" />{error && <ErrorBanner>{error}</ErrorBanner>}</form>}
      </AppDialog>
      <AppDialog open={dialog === "join"} onOpenChange={(open) => { if (!busy) setDialog(open ? "join" : null); }} icon={<IconArrowRight />} title="Join an organization" description="Paste the invitation token shared with you." footer={<><Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button form="join-organization-form" disabled={busy || !acceptToken.trim()}>Join organization</Button></>}>
        <form id="join-organization-form" className="space-y-2" noValidate onSubmit={onAccept}><Label htmlFor="accept-invite">Invitation token</Label><Input id="accept-invite" autoFocus value={acceptToken} onChange={(event) => setAcceptToken(event.target.value)} placeholder="Paste invitation token" />{error && <ErrorBanner>{error}</ErrorBanner>}<p className="text-xs text-muted-foreground">Sign in with the email address the invitation was created for.</p></form>
      </AppDialog>
      <AppDialog open={dialog === "rename"} onOpenChange={(open) => { if (!busy) setDialog(open ? "rename" : null); }} title="Rename board" description="Choose a clear name for this board." footer={<><Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button form="rename-board-form" disabled={busy || !boardName.trim()}>Save name</Button></>}>
        <form id="rename-board-form" className="space-y-2" noValidate onSubmit={updateBoard}><Label htmlFor="rename-board">Board name</Label><Input id="rename-board" autoFocus maxLength={120} value={boardName} onChange={(event) => setBoardName(event.target.value)} />{error && <ErrorBanner>{error}</ErrorBanner>}</form>
      </AppDialog>
      {visibleBoard && <TaskCardDialog open={!!activeCard} onOpenChange={(open) => { if (!busy && !open) setActiveCard(null); }} board={visibleBoard} card={activeCard} members={members} busy={busy} error={error} onSave={saveCard} onDelete={requestCardDelete} />}
    </section>
  );
}
