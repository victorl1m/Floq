# Remove Glisse integration and stale references

## Intent
Floq now uses native Mica/Acrylic/vibrancy for window transparency. Remove Glisse as a named technology from current product docs, component names, scripts and verification evidence; the removal spec/plan may retain the name as a source record.

## Goals
- Ensure no active package, code, CSS variable, style-tag, or button integration depends on Glisse.
- Remove stale Glisse-specific verification and profiling logic.
- Update all current product/design docs and project memory to describe native material and Floq-owned CSS surfaces; retain only this removal design record as a current textual mention.
- Preserve the in-progress Mica canvas/right-sidebar behavior and native Tauri material implementation.

## Non-goals
- Do not replace Floq's local CSS translucency, opaque surface components, or native Mica/Acrylic/Solid preferences.
- Do not remove the legacy preference reader that clears obsolete stored 'glass'/'system' values.
- Do not change unrelated visual treatments or functionality.

## Approaches
- Remove all translucency: would discard Floq-owned CSS surfaces as well as Glisse; rejected because the request names Glisse and native Mica, while the CSS is a separate local fallback and content-surface system.
- Remove only the npm package: insufficient because it is already absent while stale wrappers, docs, and verification still describe Glisse as active.
- Remove the Glisse integration vocabulary and obsolete diagnostics, retain the local surface system: chosen; it makes the repository truthful without conflating native window material with ordinary CSS surfaces.

## Constraints
- Native material application in src-tauri and src/lib/native-material.ts stays intact.
- Native Mica is transparent only where OS support and the user preference allow it; Solid, reduced-transparency, and forced-color fallbacks remain.
- No native desktop visual run is available in the standard agent sandbox; report that limitation.
