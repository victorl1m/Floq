# Remove Glisse integration and stale references: implementation plan

**Architecture:** There is no current Glisse dependency or runtime import. Rename the local opaque GlassSurface wrapper to a Floq-owned surface, remove stale Glisse-only diagnostics, and update the product/design records. Preserve generic CSS translucency and native material code.

**Tech stack:** React/TypeScript, CSS, Python UI tooling, npm manifests (currently already free of Glisse).

**Spec:** docs/superpowers/specs/2026-11-05-remove-glisse.md

## Global constraints
- Preserve pending Mica canvas/right-sidebar changes.
- Keep Mica, Acrylic, Vibrancy, Solid, reduced-transparency, and forced-color behavior.
- Retain migration that clears retired localStorage choices 'glass' and 'system'.
- Avoid introducing another visual-material dependency.

## Tasks

### Task 1: Rename the app-owned surface wrapper
- Rename src/components/ui/glass-surface.tsx and its exported component to FloqSurface.
- Update all imports/usages without changing rendered markup or styling.
- Update component-system documentation to identify the local component.

### Task 2: Remove Glisse-only diagnostics
- Delete scripts/probe-glisse-leak.py.
- Remove Glisse-specific selectors, deferred-registration waits, CLI switches, output fields, and assertions from scripts/verify-ui.py, scripts/profile-ui.py, scripts/profile-sidebar-ab.py, scripts/probe-buttons.py, scripts/probe-button-states.py, scripts/probe-material-fallbacks.py, scripts/verify-frosted-surfaces.py, and scripts/verify-final-refinements.py.
- Preserve unrelated UI diagnostics and the evidence path required by premium-ui.json. Remove obsolete Glisse-only fields/checks from docs/ui-verification.json without claiming a new native visual run.

### Task 3: Update product and design records
- Remove Glisse from active product/design records and tooling: PRODUCT.md, DESIGN.md, UX-CONTRACT.md, docs/ui-rework.md, docs/ui-research.md, docs/component-system.md, .impeccable/design.json, and the tracked UI evidence report. Preserve the removal spec/plan as the sole source record naming the removed technology.
- Document that Floq CSS surfaces and native OS material are separate systems.
- Append the implementation outcome to relevant Floq project memory.

### Task 4: Audit and release
- Search tracked source, manifests, docs, and scripts for Glisse package names, imports, generated selectors, and active requirements; only the removal spec/plan may contain the removed name.
- Confirm native material files and Mica canvas rules remain intact; run requested checks and release workflow.
