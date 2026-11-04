import { flushSync } from "react-dom";

type NativeViewTransition = {
  ready?: Promise<unknown>;
  finished?: Promise<unknown>;
  skipAnimation?: () => void;
  skipTransition?: () => void;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => NativeViewTransition;
};

let activeTransition: NativeViewTransition | null = null;

function motionIsReduced(doc: Document, userPrefersReducedMotion: boolean): boolean {
  if (userPrefersReducedMotion) return true;
  if (
    doc.documentElement.classList.contains("floq-reduced-motion") ||
    doc.body?.classList.contains("floq-reduced-motion")
  ) return true;

  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Run one synchronous React update inside the browser's same-document transition API when available. */
export function runViewTransition(update: () => void, userPrefersReducedMotion = false): void {
  if (typeof document === "undefined") {
    update();
    return;
  }

  const doc = document as ViewTransitionDocument;
  const startTransition = doc.startViewTransition;
  if (!startTransition || motionIsReduced(doc, userPrefersReducedMotion)) {
    update();
    return;
  }

  if (activeTransition) {
    try {
      if (activeTransition.skipAnimation) activeTransition.skipAnimation();
      else activeTransition.skipTransition?.();
    } catch {
      // A finished transition may reject a skip request; navigation still proceeds below.
    }
    activeTransition = null;
  }

  let updateCalled = false;
  let transition: NativeViewTransition;
  try {
    transition = startTransition.call(doc, () => {
      updateCalled = true;
      flushSync(update);
    });
  } catch {
    // A failed snapshot can fall back to a direct update, but never repeat an update already run.
    if (!updateCalled) update();
    return;
  }

  activeTransition = transition;
  // A capture can be abandoned (for example, if the document changes during capture).
  // Consume both rejections so navigation never creates an unhandled promise rejection.
  void transition.ready?.catch(() => undefined);
  void transition.finished?.then(
    () => { if (activeTransition === transition) activeTransition = null; },
    () => { if (activeTransition === transition) activeTransition = null; },
  );
}
