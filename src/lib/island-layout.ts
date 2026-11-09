export const ISLAND_MORPH_MS = 320;
export interface IslandLayout { expanded: boolean; height: number; pinned: boolean }
const same = (a: IslandLayout, b: IslandLayout) => a.expanded === b.expanded && a.height === b.height && a.pinned === b.pinned;
interface Clock { set: (job: () => void, delay: number) => ReturnType<typeof setTimeout>; clear: (id: ReturnType<typeof setTimeout>) => void }

/** CSS owns the visible morph. Growth (including expanded content growing) applies immediately; shrinks wait for the morph. */
export function createIslandLayoutController(
  apply: (layout: IslandLayout) => void | Promise<void>,
  clock: Clock = { set: setTimeout, clear: clearTimeout },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: IslandLayout | undefined, generation = 0, disposed = false;
  let native: IslandLayout = { expanded: false, height: 40, pinned: false };
  const cancel = () => { if (timer !== undefined) clock.clear(timer); timer = undefined; };
  return {
    request(layout: IslandLayout, reducedMotion = false) {
      if (disposed) return;
      const next = { ...layout, height: layout.expanded ? Math.max(40, Math.min(560, layout.height)) : 40 };
      if (last && same(last, next) && !(reducedMotion && timer !== undefined)) return;
      const hadPending = timer !== undefined;
      last = next; cancel();
      const current = ++generation;
      // A pending shrink cancelled by a re-expand leaves the native window as it already is: no redundant resize.
      if (hadPending && same(native, next)) return;
      const flush = () => {
        timer = undefined;
        if (disposed || current !== generation) return;
        const previous = native;
        native = next;
        try {
          void Promise.resolve(apply(next)).catch(() => {
            if (current === generation && !disposed) { last = undefined; native = previous; }
          });
        } catch {
          if (current === generation && !disposed) { last = undefined; native = previous; }
        }
      };
      if (!reducedMotion && (next.height < native.height || (!next.expanded && native.expanded))) timer = clock.set(flush, ISLAND_MORPH_MS);
      else flush();
    },
    reset() { cancel(); ++generation; last = undefined; native = { expanded: false, height: 40, pinned: false }; },
    dispose() { disposed = true; cancel(); ++generation; },
  };
}
