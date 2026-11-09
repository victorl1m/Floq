import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createIslandLayoutController } from '@/lib/island-layout';

/** Keep content at a stable width and animate explicit shell heights, never height:auto. */
export function useIslandLayout({ active, expanded, pinned, requestKey, content }: {
  active: boolean; expanded: boolean; pinned: boolean; requestKey?: string;
  content: RefObject<HTMLDivElement | null>;
}) {
  const [height, setHeight] = useState(40);
  const [visibleExpanded, setVisibleExpanded] = useState(expanded);
  const [viewportHeight, setViewportHeight] = useState(40);
  const [width, setWidth] = useState(440);
  const [reducedMotion, setReducedMotion] = useState(false);
  const requested = useRef({ active, expanded });
  requested.current = { active, expanded };
  const controller = useRef<ReturnType<typeof createIslandLayoutController> | null>(null);
  const wasActive = useRef(false);
  useLayoutEffect(() => {
    let alive = true, sequence = 0;
    const layout = createIslandLayoutController(async value => {
      const ticket = ++sequence;
      const viewport = await invoke<{ width: number; height: number } | null>('island_set_layout', { ...value });
      if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error('Island viewport is unavailable');
      // Reserve native space before revealing the expanding shell. A late reply
      // from an interrupted opening must never reopen a now-collapsed island.
      if (alive && ticket === sequence && requested.current.active) {
        setViewportHeight(viewport.height);
        if (value.expanded) setWidth(Math.min(440, viewport.width));
        if (requested.current.expanded && value.expanded) setVisibleExpanded(true);
      }
    });
    controller.current = layout;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    update(); query.addEventListener('change', update);
    return () => { alive = false; query.removeEventListener('change', update); layout.dispose(); controller.current = null; };
  }, []);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setHeight(Math.max(40, Math.min(560, Math.ceil(element.scrollHeight) + 2)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, requestKey, content]);
  useLayoutEffect(() => {
    if (!active) { wasActive.current = false; controller.current?.reset(); return; }
    if (!wasActive.current) {
      wasActive.current = true;
      setVisibleExpanded(false);
      setViewportHeight(40);
    }
    if (!expanded) setVisibleExpanded(false);
    controller.current?.request({ expanded, height: expanded ? height : 40, pinned }, reducedMotion);
    // One state machine: when the OS window is already expanded and tall enough (re-hover during the pending shrink,
    // or growth of an open card) there is no native round trip to wait for, so the capsule opens in this same commit.
    if (expanded && controller.current?.nativeReady(height)) setVisibleExpanded(true);
  }, [active, expanded, height, pinned, reducedMotion]);
  return {
    height: visibleExpanded ? Math.min(height, viewportHeight) : 40,
    expanded: visibleExpanded,
    width,
    contentMaxHeight: Math.max(1, Math.min(558, viewportHeight - 2)),
  };
}
