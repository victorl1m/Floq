import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { IconAlertTriangle } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useRuntime } from "@/lib/runtime/store";
import type { PluginInfo } from "@/lib/runtime/types";
import { toast } from "sonner";
import { subscribePluginEvent, subscribePluginToasts } from "./events";
import { UI_PLUGINS } from "./index";
import { loadRemoteUi } from "./remote-ui";
import { activeContributions, idsToLoad, isActive, type Contributions } from "./registry";
import type { UiPluginDefinition } from "./sdk";

interface PluginsValue extends Contributions {
  /** Every plugin the server lists (any status): used by Settings > Plugins. */
  all: PluginInfo[];
  loading: boolean;
  /** Loaded UI halves by plugin id (for custom settings panels). */
  ui: Record<string, UiPluginDefinition | undefined>;
  /** Re-read `/v1/plugins`. Call after enabling, disabling or toggling a plugin. */
  refresh: () => Promise<void>;
  /** Open the Secrets view / Settings > Plugins: the actions of the kit's not-configured state. */
  openSecrets: () => void;
  openSettings: () => void;
}

const EMPTY: Contributions = { plugins: [], views: [], tabs: [], taskSources: [] };
const PluginsContext = createContext<PluginsValue | null>(null);

/** Fed by `listPlugins`. A runtime without the plugin API, a failed request or a failing UI module simply contributes nothing. */
export function PluginsProvider({ children, loaders = UI_PLUGINS }: { children: ReactNode; loaders?: typeof UI_PLUGINS }) {
  const { client, user, navigate, openSettings } = useRuntime();
  const [all, setAll] = useState<PluginInfo[]>([]);
  const [loaded, setLoaded] = useState<Record<string, UiPluginDefinition | undefined>>({});
  const [loading, setLoading] = useState(false);
  const attempted = useRef(new Set<string>());
  const signedIn = Boolean(client && user);

  // `ctx.toast` from any plugin shows on every screen.
  useEffect(() => subscribePluginToasts(({ title, description }) => { toast(title, description ? { description } : undefined); }), []);

  const refresh = useCallback(async () => {
    if (!client) { setAll([]); return; }
    setLoading(true);
    try { setAll(await client.listPlugins()); } catch { setAll([]); } finally { setLoading(false); }
  }, [client]);

  useEffect(() => { attempted.current.clear(); setLoaded({}); if (signedIn) void refresh(); else setAll([]); }, [signedIn, refresh]);

  useEffect(() => {
    const ids = idsToLoad(all, Object.fromEntries([...attempted.current].map((id) => [id, true])), loaders);
    for (const id of ids) {
      attempted.current.add(id);
      void loaders[id]().then((m) => setLoaded((prev) => ({ ...prev, [id]: m.default })), (error) => console.warn("Plugin UI failed to load", id, error));
    }
    // Installed plugins ship their UI as a bundle served by the runtime: verified against the listed sha256, then imported from a Blob.
    if (!client) return;
    for (const p of all) {
      if (!p.ui || !isActive(p) || loaders[p.id] || attempted.current.has(p.id)) continue;
      attempted.current.add(p.id);
      void (async () => {
        await import("./shared-runtime");
        const script = await client.pluginUiScript(p.id);
        const def = await loadRemoteUi(script.text, p.ui!.sha256, script.sha256);
        setLoaded((prev) => ({ ...prev, [p.id]: def }));
      })().catch((error) => console.warn("Plugin UI failed to load", p.id, error instanceof Error ? error.message : error));
    }
  }, [all, loaders, client]);

  const value = useMemo<PluginsValue>(() => ({ ...activeContributions(all, loaded), all, loading, ui: loaded, refresh, openSecrets: () => navigate("secrets"), openSettings: () => openSettings("plugins") }), [all, loaded, loading, refresh, navigate, openSettings]);
  return <PluginsContext.Provider value={value}>{children}</PluginsContext.Provider>;
}

export function usePlugins(): PluginsValue {
  const value = useContext(PluginsContext);
  if (value) return value;
  return { ...EMPTY, all: [], loading: false, ui: {}, refresh: async () => undefined, openSecrets: () => undefined, openSettings: () => undefined };
}

/** Calls a plugin's own routes (`/v1/plugins/<id>/api/*`) with the signed-in user's session. This is the only way plugin UI reaches the runtime. */
export function usePluginApi(pluginId: string) {
  const { client } = useRuntime();
  return useCallback(<T = unknown,>(path: string, init?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown }): Promise<T> => {
    if (!client) return Promise.reject(new Error("Not signed in"));
    return client.pluginFetch<T>(pluginId, path, init);
  }, [client, pluginId]);
}

/** Live `ctx.events.publish` frames of one plugin and event name, for the signed-in user only. The callback may change between renders. */
export function usePluginEvent<T = unknown>(pluginId: string, name: string, callback: (data: T) => void): void {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => subscribePluginEvent(pluginId, name, (data) => latest.current(data as T)), [pluginId, name]);
}

/** The main-area screen of a plugin view (`<pluginId>/<viewId>`). While the plugin is not active for this user it shows a disabled state, then returns Home. */
export function PluginViewHost({ viewId }: { viewId: string | null }) {
  const { views, all, loading, openSettings } = usePlugins();
  const { navigate } = useRuntime();
  const active = views.find((v) => `${v.pluginId}/${v.viewId}` === viewId);
  const known = all.length > 0 || !loading;
  useEffect(() => { if (!active && known && !loading) navigate("home"); }, [active, known, loading, navigate]);
  if (!active) return <div className="absolute inset-0 flex p-6"><PluginBoundaryEmpty onOpenSettings={openSettings} loading={loading} /></div>;
  const { Component } = active;
  return <div className="absolute inset-0" data-plugin-view={viewId ?? undefined}><PluginBoundary pluginId={active.pluginId}><Component plugin={active.plugin} view={active.decl} /></PluginBoundary></div>;
}

function PluginBoundaryEmpty({ onOpenSettings, loading }: { onOpenSettings: () => void; loading: boolean }) {
  return (
    <Empty role="status">
      <EmptyHeader>
        <EmptyMedia variant="icon"><IconAlertTriangle /></EmptyMedia>
        <EmptyTitle>{loading ? "Loading plugin…" : "This plugin is not available"}</EmptyTitle>
        <EmptyDescription>{loading ? "One moment." : "It may be turned off. You can manage plugins in Settings."}</EmptyDescription>
      </EmptyHeader>
      {!loading && <EmptyContent><Button variant="outline" size="sm" onClick={onOpenSettings}>Plugin settings</Button></EmptyContent>}
    </Empty>
  );
}

interface BoundaryProps { pluginId: string; children: ReactNode; /** Test hook: renders the fallback without waiting for a render error. */ error?: Error | null }
interface BoundaryState { error: Error | null }

/** Contains render errors of one plugin component so the rest of Floq stays usable. */
export class PluginBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: this.props.error ?? null };

  static getDerivedStateFromError(error: Error): BoundaryState { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Plugin UI error", this.props.pluginId, error, info.componentStack); }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="absolute inset-0 flex p-6" role="alert" data-plugin-error={this.props.pluginId}>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><IconAlertTriangle /></EmptyMedia>
            <EmptyTitle>This plugin ran into a problem</EmptyTitle>
            <EmptyDescription>The rest of Floq is unaffected. Try again, or disable the plugin in Settings.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button variant="outline" size="sm" onClick={() => this.setState({ error: null })}>Retry</Button></EmptyContent>
        </Empty>
      </div>
    );
  }
}
