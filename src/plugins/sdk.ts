import { useEffect, useRef, type ComponentType } from "react";
import type { PluginInfo, PluginViewDecl, PluginTaskSourceDecl, PluginRightSidebarTabDecl } from "../lib/runtime/types";

export type {
  PluginInfo, PluginScope, PluginStatus, PluginSettingDecl, PluginSettingType, PluginSettingValues,
  PluginViewDecl, PluginTaskSourceDecl, PluginRightSidebarTabDecl, PluginContributes,
} from "../lib/runtime/types";

/** Props every plugin view receives. */
export interface PluginViewProps { plugin: PluginInfo; view: PluginViewDecl }
export interface PluginTabProps { plugin: PluginInfo; tab: PluginRightSidebarTabDecl }
export interface PluginTaskSourceProps { plugin: PluginInfo; source: PluginTaskSourceDecl }

/**
 * UI half of a plugin. Keys must match ids declared in the plugin's manifest (`contributes.*`);
 * a component without a matching declaration, or a declaration without a component, is ignored.
 */
export interface UiPluginDefinition {
  views?: Record<string, ComponentType<PluginViewProps>>;
  rightSidebarTabs?: Record<string, ComponentType<PluginTabProps>>;
  taskSources?: Record<string, ComponentType<PluginTaskSourceProps>>;
  /** Custom settings component rendered below the generic form when `contributes.settingsPanel` is true. */
  settingsPanel?: ComponentType<{ plugin: PluginInfo }>;
}

export const defineUiPlugin = (def: UiPluginDefinition): UiPluginDefinition => def;


// ---- "open this view at X" (a notification's target, see runtime `ctx.notify({ target })`) ----
type OpenParams = Record<string, string>;
const pendingOpen = new Map<string, OpenParams>();
const openListeners = new Map<string, Set<(params: OpenParams) => void>>();
/** Host side: hands params to a plugin view. A mounted view gets them at once; otherwise they wait for its next mount. */
export function deliverPluginOpen(pluginId: string, viewId: string, params: OpenParams): void {
  const key = pluginId + "/" + viewId;
  const set = openListeners.get(key);
  if (set?.size) for (const fn of [...set]) fn(params);
  else pendingOpen.set(key, params);
}
/**
 * Plugin view side: `callback` gets the params of a notification target that opened this view (e.g. `{ chat, session }`), once per
 * open, whether the view was already on screen or is mounting because of it. The callback may change between renders.
 */
export function usePluginOpen(pluginId: string, viewId: string, callback: (params: OpenParams) => void): void {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    const key = pluginId + "/" + viewId;
    const fn = (params: OpenParams) => latest.current(params);
    let set = openListeners.get(key);
    if (!set) openListeners.set(key, (set = new Set()));
    set.add(fn);
    const waiting = pendingOpen.get(key);
    if (waiting) { pendingOpen.delete(key); fn(waiting); }
    return () => { set!.delete(fn); };
  }, [pluginId, viewId]);
}
