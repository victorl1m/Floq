import { useMemo, useState, type ReactNode } from "react";
import { IconCheck, IconSearch, IconStar, IconStarFilled } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TaskTeam } from "@/lib/runtime/types";

type BoardItem = { id: string; title: string };

interface TaskBoardNavigatorProps {
  teams: TaskTeam[];
  teamId: string;
  boards: BoardItem[];
  boardId: string;
  favorites: string[];
  recent: string[];
  onTeamChange: (teamId: string) => void;
  onBoardChange: (boardId: string) => void;
  onFavoriteToggle: (boardId: string) => void;
  onCreateTeam: () => void;
  onCreateBoard: () => void;
  sourceNavigation?: ReactNode;
  className?: string;
}

export default function TaskBoardNavigator({
  teams,
  teamId,
  boards,
  boardId,
  favorites,
  recent,
  onTeamChange,
  onBoardChange,
  onFavoriteToggle,
  onCreateTeam,
  onCreateBoard,
  sourceNavigation,
  className,
}: TaskBoardNavigatorProps) {
  const [query, setQuery] = useState("");
  const selectedTeam = teams.find((team) => team.id === teamId);
  const boardById = useMemo(() => new Map(boards.map((board) => [board.id, board])), [boards]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingBoards = useMemo(
    () => boards.filter((board) => board.title.toLocaleLowerCase().includes(normalizedQuery)),
    [boards, normalizedQuery],
  );
  const favoriteBoards = normalizedQuery
    ? matchingBoards.filter((board) => favorites.includes(board.id))
    : favorites.map((id) => boardById.get(id)).filter((board): board is BoardItem => !!board);
  const favoriteIds = new Set(favoriteBoards.map((board) => board.id));
  const allRecentBoards = normalizedQuery
    ? matchingBoards.filter((board) => !favoriteIds.has(board.id) && recent.includes(board.id))
    : recent.map((id) => boardById.get(id)).filter((board): board is BoardItem => !!board && !favoriteIds.has(board.id));
  const recentBoards = allRecentBoards.slice(0, 5);
  const recentIds = new Set(recentBoards.map((board) => board.id));
  const allBoards = matchingBoards.filter((board) => !favoriteIds.has(board.id) && !recentIds.has(board.id));
  const noResults = normalizedQuery && !matchingBoards.length;

  const renderGroup = (title: string, items: BoardItem[]) => items.length > 0 && (
    <section className="mb-4" aria-label={title}>
      <h3 className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul className="space-y-0.5">
        {items.map((board) => {
          const active = board.id === boardId;
          const favorite = favorites.includes(board.id);
          return (
            <li key={board.id} className="group flex min-w-0 items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                aria-current={active ? "page" : undefined}
                className={`h-8 min-w-0 flex-1 justify-start gap-2 px-2 text-left ${active ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground"}`}
                onClick={() => onBoardChange(board.id)}
              >
                {active ? <IconCheck className="size-3.5 shrink-0" /> : <span className="size-3.5 shrink-0" />}
                <span className="truncate">{board.title}</span>
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`${favorite ? "Remove" : "Add"} ${board.title} ${favorite ? "from" : "to"} favorites`}
                aria-pressed={favorite}
                className="shrink-0 opacity-70 hover:opacity-100 focus-visible:opacity-100"
                onClick={() => onFavoriteToggle(board.id)}
              >
                {favorite ? <IconStarFilled className="size-3 text-amber-500" /> : <IconStar className="size-3" />}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );

  return (
    <div className={`flex min-h-0 min-w-0 flex-col ${className ?? ""}`}>
      <div className="space-y-2 border-b p-3">
        <div className="flex items-center justify-between px-1"><p className="text-[11px] font-medium uppercase tracking-[0.13em] text-muted-foreground">Boards</p><Badge variant="outline" className="h-5 px-1.5 text-[10px]">{boards.length}</Badge></div>
        {teams.length > 0 ? (
          <Select value={teamId} onValueChange={onTeamChange}>
            <SelectTrigger aria-label="Choose team" className="w-full"><SelectValue placeholder="Choose a team" /></SelectTrigger>
            <SelectContent avoidCollisions position="popper" className="w-[var(--radix-select-trigger-width)] min-w-0">
              {teams.map((team) => <SelectItem key={team.id} value={team.id} textValue={team.name}><span className="min-w-0 flex-1 truncate">{team.name}</span></SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <Button size="sm" className="w-full" onClick={onCreateTeam}>Create a team</Button>
        )}
        {teams.length > 0 && <div className="relative"><IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search boards" data-task-board-search="true" className="h-8 pl-8 pr-8" placeholder="Find a board" value={query} onChange={(event) => setQuery(event.target.value)} /><Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">B</Kbd></div>}
      </div>
      {!normalizedQuery && sourceNavigation && <div className="border-b p-2">{sourceNavigation}</div>}
      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label={`${selectedTeam?.name ?? "Team"} boards`} className="p-2">
          {noResults ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No boards match “{query}”.</p>
          ) : normalizedQuery ? (
            renderGroup("Search results", matchingBoards)
          ) : (
            <>
              {renderGroup("Favorites", favoriteBoards)}
              {renderGroup("Recent", recentBoards)}
              {renderGroup("All boards", allBoards)}
              {!normalizedQuery && !boards.length && <p className="px-2 py-4 text-sm text-muted-foreground">No boards yet.</p>}
            </>
          )}
        </nav>
      </ScrollArea>
      {teams.length > 0 && <div className="border-t p-3"><Button variant="outline" size="sm" className="w-full" onClick={onCreateBoard}>Create board</Button></div>}
    </div>
  );
}
