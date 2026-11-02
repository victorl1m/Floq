import { useCallback, useEffect, useRef, useState } from "react";
import { IconGitBranch, IconLock, IconSearch } from "@tabler/icons-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { AppDialog, ErrorBanner } from "@/components/ui/app-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GithubFlowPanel, useGithubDeviceFlow } from "@/components/settings/github-device-flow";
import { RuntimeError } from "@/lib/runtime/client";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import type { GithubRepo } from "@/lib/runtime/types";
import { cn } from "cn";

const urlSchema = z
    .string()
    .trim()
    .min(1, "Enter a repository URL")
    .refine(
        (v) => /^https:\/\/[^\s/]+\/[^\s]+$/.test(v) || /^git@[^\s:]+:[^\s]+$/.test(v) || /^ssh:\/\/[^\s]+$/.test(v),
        "Use an https URL or an SSH address like git@github.com:owner/repo.git",
    );

/** "owner/repo" from a clone URL, for the folder label. */
function labelFromUrl(url: string): string {
    const match = /[/:]([^/:]+\/[^/:]+?)(?:\.git)?\/?$/.exec(url.trim());
    return match ? match[1] : url.trim();
}

function RepoPicker({ onSelect, selected }: { onSelect: (repo: GithubRepo) => void; selected: string | null }) {
    const client = useClient();
    const [query, setQuery] = useState("");
    const [debounced, setDebounced] = useState("");
    const [repos, setRepos] = useState<GithubRepo[]>([]);
    const [nextPage, setNextPage] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [failedRequest, setFailedRequest] = useState<{ query: string; page: number; append: boolean } | null>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const sentinelRef = useRef<HTMLLIElement>(null);
    const loadingRef = useRef(false);
    const queryRef = useRef(debounced);
    const queryRevision = useRef(0);
    queryRef.current = debounced;

    useEffect(() => {
        const t = setTimeout(() => setDebounced(query.trim()), 250);
        return () => clearTimeout(t);
    }, [query]);

    const load = useCallback(
        async (q: string, page: number, append: boolean) => {
            const revision = queryRevision.current;
            if (loadingRef.current) return;
            loadingRef.current = true;
            setLoading(true);
            setError(null);
            setFailedRequest(null);
            try {
                const result = await client.githubRepos(q, page);
                if (q === queryRef.current && revision === queryRevision.current) {
                    setRepos((prev) => (append ? [...prev, ...result.repos] : result.repos));
                    setNextPage(result.nextPage);
                }
            } catch (e) {
                if (q === queryRef.current && revision === queryRevision.current) {
                    setFailedRequest({ query: q, page, append });
                    setError(
                        e instanceof RuntimeError && (e.status === 404 || e.status === 405)
                            ? "Update your runtime to browse repositories. Use the URL tab meanwhile."
                            : errorMessage(e),
                    );
                }
            } finally {
                loadingRef.current = false;
                setLoading(false);
                if (q !== queryRef.current || revision !== queryRevision.current) void load(queryRef.current, 1, false);
            }
        },
        [client],
    );

    useEffect(() => {
        queryRevision.current++;
        setRepos([]);
        setNextPage(null);
        setError(null);
        void load(debounced, 1, false);
    }, [debounced, load]);

    useEffect(() => {
        const root = listRef.current;
        const target = sentinelRef.current;
        if (!root || !target || !nextPage || loading || error) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting) && !loadingRef.current && queryRef.current === debounced) {
                    void load(debounced, nextPage, true);
                }
            },
            { root, rootMargin: "0px 0px 80px 0px" },
        );
        observer.observe(target);
        return () => observer.disconnect();
    }, [debounced, error, load, loading, nextPage]);

    return (
        <div className="flex flex-col gap-3">
            <div className="relative">
                <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-8" placeholder="Search your repositories" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <ul ref={listRef} aria-busy={loading} className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                    {repos.map((repo) => (
                        <li key={repo.fullName}>
                            <button
                                type="button"
                                onClick={() => onSelect(repo)}
                                className={cn(
                                    "flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
                                    selected === repo.cloneUrl && "bg-muted",
                                )}
                            >
                                <span className="flex items-center gap-1.5 font-medium">
                                    {repo.fullName}
                                    {repo.private && <IconLock className="size-3 text-muted-foreground" aria-label="Private" />}
                                    <span className="ml-auto text-xs font-normal text-muted-foreground">
                                        {formatDistanceToNow(new Date(repo.updatedAt), { addSuffix: true })}
                                    </span>
                                </span>
                                {repo.description && <span className="truncate text-xs text-muted-foreground">{repo.description}</span>}
                            </button>
                        </li>
                    ))}
                    {!loading && !error && repos.length === 0 && <li className="p-3 text-sm text-muted-foreground">No repositories found.</li>}
                    {nextPage && <li ref={sentinelRef} aria-hidden="true" className="h-px" />}
                    {loading && repos.length > 0 && <li className="flex justify-center py-2" role="status"><Spinner /><span className="sr-only">Loading more repositories</span></li>}
                    {error && <li className="flex items-center justify-between gap-2 p-2" role="alert"><ErrorBanner>{error}</ErrorBanner><Button variant="outline" size="sm" onClick={() => failedRequest && void load(failedRequest.query, failedRequest.page, failedRequest.append)}>Retry</Button></li>}
                </ul>
            {loading && repos.length === 0 && (
                <div className="flex flex-col gap-2">
                    {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-11 w-full rounded-lg" />
                    ))}
                </div>
            )}
        </div>
    );
}

function GithubTabContent({ onSelect, selected }: { onSelect: (repo: GithubRepo) => void; selected: string | null }) {
    const client = useClient();
    const { info } = useRuntime();
    const [connected, setConnected] = useState<boolean | null>(null);

    const refresh = useCallback(async () => {
        try {
            setConnected((await client.settings()).github !== null);
        } catch (e) {
            toast.error("Could not load GitHub status", { description: errorMessage(e) });
            setConnected(false);
        }
    }, [client]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const device = useGithubDeviceFlow(refresh);

    if (info && !info.githubConfigured) {
        return <p className="text-sm text-muted-foreground">GitHub login isn't configured on this runtime. Use the URL tab instead.</p>;
    }
    if (connected === null) {
        return (
            <div className="flex justify-center py-8">
                <Spinner />
            </div>
        );
    }
    if (!connected) {
        return device.flow ? (
            <GithubFlowPanel flow={device.flow} onCancel={device.cancel} />
        ) : (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
                <p className="text-sm text-muted-foreground">Connect GitHub to browse and clone your repositories.</p>
                <Button disabled={device.starting} onClick={() => void device.start()}>
                    {device.starting && <Spinner />}
                    Connect GitHub
                </Button>
            </div>
        );
    }
    return <RepoPicker onSelect={onSelect} selected={selected} />;
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onClone: (repo: { label: string; url: string }) => Promise<void>;
}

export default function CloneDialog({ open, onOpenChange, onClone }: Props) {
    const [tab, setTab] = useState("github");
    const [repo, setRepo] = useState<GithubRepo | null>(null);
    const [url, setUrl] = useState("");
    const [urlError, setUrlError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [cloneError, setCloneError] = useState<string | null>(null);

    async function submit() {
        if (busy) return;
        let selected: { label: string; url: string };
        if (tab === "github") {
            if (!repo) return;
            selected = { label: repo.fullName, url: repo.cloneUrl };
        } else {
            const parsed = urlSchema.safeParse(url);
            if (!parsed.success) return setUrlError(parsed.error.issues[0].message);
            selected = { label: labelFromUrl(parsed.data), url: parsed.data };
        }
        setBusy(true);
        setCloneError(null);
        try {
            await onClone(selected);
            onOpenChange(false);
        } catch (error) {
            setCloneError(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    }

    return (
        <AppDialog
            open={open}
            onOpenChange={(next) => !busy && onOpenChange(next)}
            size="lg"
            icon={<IconGitBranch />}
            title="Clone a repository"
            description="Clone a repository into your projects. It will be ready before you start an agent."
            footerStart={tab === "github" ? <button type="button" className="underline" onClick={() => setTab("url")}>Use URL instead</button> : null}
            footer={
                <>
                    <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button disabled={busy || (tab === "github" ? !repo : !url.trim())} onClick={() => void submit()}>
                        {busy && <Spinner />}
                        {busy ? "Cloning…" : "Clone project"}
                    </Button>
                </>
            }
        >
            <Tabs value={tab} onValueChange={setTab}>
                <TabsList>
                    <TabsTrigger value="github">GitHub</TabsTrigger>
                    <TabsTrigger value="url">URL</TabsTrigger>
                </TabsList>
                <TabsContent value="github" className="pt-2">
                    <GithubTabContent onSelect={setRepo} selected={repo?.cloneUrl ?? null} />
                </TabsContent>
                <TabsContent value="url" className="flex flex-col gap-2 pt-2">
                    <Input
                        autoFocus
                        placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git"
                        value={url}
                        aria-invalid={urlError !== null}
                        onChange={(e) => {
                            setUrl(e.target.value);
                            setUrlError(null);
                        }}
                        onKeyDown={(e) => e.key === "Enter" && submit()}
                    />
                    {urlError && <ErrorBanner>{urlError}</ErrorBanner>}
                </TabsContent>
            </Tabs>
            {cloneError && <ErrorBanner>{cloneError}</ErrorBanner>}
        </AppDialog>
    );
}
