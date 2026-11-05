# Mica Canvas and Right Sidebar Implementation Plan

> Follow the project's existing native-material CSS in `src/index.css`; do not change native Tauri material application or user preferences.

**Goal:** Let applied native Mica/Acrylic/vibrancy show through the canvas plane, canvas topbar and editable fields, and right sidebar pane while keeping working content readable.

**Approach:** Use theme-aware translucent pane and control tokens under `[data-native-material]`. Make the canvas workspace wrapper transparent so it does not stack a second opaque tint over the canvas. Keep canvas cards, sidebar contents, terminals, dialogs, and popovers readable. Preserve Solid, OS reduced-transparency, and forced-color fallbacks.

**Files:** `src/App.tsx` marks the active workspace view; `src/index.css` owns material tokens and selectors; `DESIGN.md` and `UX-CONTRACT.md` document the visual contract.

**Verification:** `git diff --check` passes. Native Mica visual rendering cannot be verified in the agent environment; a Windows app check is still needed.
