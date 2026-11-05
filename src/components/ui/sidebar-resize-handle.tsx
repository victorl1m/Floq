import * as React from "react"
import { cn } from "@/lib/utils"
import {
  SIDEBAR_MIN_PX,
  SIDEBAR_STEP_LARGE_PX,
  SIDEBAR_STEP_PX,
  getEffectiveSidebarWidth,
  getSidebarMax,
  previewSidebarWidth,
  resetSidebarWidth,
  setSidebarWidth,
  useSidebarWidth,
} from "@/lib/sidebar-width"

const CLICK_MOVE_THRESHOLD_PX = 3
// A click hides the sidebar, but a double-click must still reset the width: wait out the double-click window.
const CLICK_HIDE_DELAY_MS = 250

/**
 * Drag/keyboard handle on the left sidebar's right edge. Live drag only writes a CSS variable (rAF-throttled);
 * React state is touched once, on release.
 */
export function SidebarResizeHandle({ className, onHide }: { className?: string; onHide?: () => void }) {
  const width = useSidebarWidth()
  const max = getSidebarMax()
  const ref = React.useRef<HTMLDivElement>(null)
  const drag = React.useRef<{ id: number; startX: number; startWidth: number; width: number; frame: number; moved: boolean } | null>(null)

  const hideTimer = React.useRef(0)
  const onHideRef = React.useRef(onHide)
  onHideRef.current = onHide

  const syncDom = React.useCallback((px: number) => {
    const el = ref.current
    if (!el) return
    const limit = getSidebarMax()
    el.setAttribute("aria-valuenow", String(px))
    el.setAttribute("aria-valuemax", String(limit))
    el.dataset.limit = px <= SIDEBAR_MIN_PX ? "min" : px >= limit ? "max" : ""
  }, [])

  const endDrag = React.useCallback((commit: boolean) => {
    const state = drag.current
    if (!state) return
    drag.current = null
    cancelAnimationFrame(state.frame)
    delete document.documentElement.dataset.sidebarResizing
    delete ref.current?.dataset.dragging
    if (commit) setSidebarWidth(state.width)
    else setSidebarWidth(getEffectiveSidebarWidth())
  }, [])

  React.useEffect(() => () => {
    window.clearTimeout(hideTimer.current)
    if (drag.current) endDrag(true)
  }, [endDrag])

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    window.clearTimeout(hideTimer.current)
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: event.pointerId, startX: event.clientX, startWidth: getEffectiveSidebarWidth(), width: getEffectiveSidebarWidth(), frame: 0, moved: false }
    document.documentElement.dataset.sidebarResizing = "true"
    event.currentTarget.dataset.dragging = "true"
    ref.current?.focus({ preventScroll: true })
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const state = drag.current
    if (!state || event.pointerId !== state.id) return
    if (!state.moved && Math.abs(event.clientX - state.startX) < CLICK_MOVE_THRESHOLD_PX) return
    state.moved = true
    const next = state.startWidth + (event.clientX - state.startX)
    cancelAnimationFrame(state.frame)
    state.frame = requestAnimationFrame(() => {
      state.width = previewSidebarWidth(next)
      syncDom(state.width)
    })
  }

  function onPointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    const state = drag.current
    if (!state || event.pointerId !== state.id) return
    // Apply the final pointer position synchronously so release never lags a frame behind.
    const cancelled = event.type === "pointercancel"
    if (Math.abs(event.clientX - state.startX) >= CLICK_MOVE_THRESHOLD_PX) state.moved = true
    state.width = state.moved ? previewSidebarWidth(state.startWidth + (event.clientX - state.startX)) : state.startWidth
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const clicked = !state.moved && !cancelled
    endDrag(!cancelled)
    if (clicked && onHideRef.current) hideTimer.current = window.setTimeout(() => onHideRef.current?.(), CLICK_HIDE_DELAY_MS)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? SIDEBAR_STEP_LARGE_PX : SIDEBAR_STEP_PX
    const current = getEffectiveSidebarWidth()
    if (event.key === "ArrowRight") setSidebarWidth(current + step)
    else if (event.key === "ArrowLeft") setSidebarWidth(current - step)
    else if (event.key === "Home") resetSidebarWidth()
    else if (event.key === "End") setSidebarWidth(getSidebarMax())
    else return
    event.preventDefault()
  }

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN_PX}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      data-slot="sidebar-resize-handle"
      data-limit={width <= SIDEBAR_MIN_PX ? "min" : width >= max ? "max" : ""}
      title="Drag to resize, click to hide. Double-click to reset."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={() => { window.clearTimeout(hideTimer.current); resetSidebarWidth() }}
      onKeyDown={onKeyDown}
      className={cn("sidebar-resize-handle", className)}
    />
  )
}
