# Component and material system

## References

- [Apple Design Resources](https://developer.apple.com/design/resources/) and [Materials](https://developer.apple.com/design/human-interface-guidelines/materials): use materials to express hierarchy, keep foreground information legible, distinguish functional glass from content materials, and avoid layering expressive effects everywhere.
- [Glisse](https://github.com/0kzh/glisse): the actual `Glass` primitive supplies optical edge treatment on key interactive surfaces; its theme variables adapt to Floq's canonical tokens.
- [ascii-reveal](https://github.com/quanhoangindex/ascii-reveal): real ASCII placeholders and short content reveals.
- The user's supplied dark task card, frosted light panels, smoked wallet, and warm translucent desktop dashboard references guide appearance. The generated desktop mockup guided the corrective layout pass; it is a design reference, not a shipped bitmap UI.

## Shared owners

| Layer | Canonical owner | Treatment |
| --- | --- | --- |
| Workspace | `.workspace-surface`, `src/index.css` | Stationary warm peach/ember and silver light fields that remain visible through materials. |
| Navigation and chrome | Shared Sidebar, titlebar and footer | Regular translucent glass, clear selection, no ornamental selection rails. |
| Key interactive surface | `ui/glass-surface.tsx` | Glisse `Glass`, mapped through `--lg-*` to Floq semantic variables; used for the task composer. |
| Content | Shared Card, `.material-content` | Thicker frosted fill with restrained depth; readable task and table content. |
| Controls | Existing shadcn Button/Input/Select/Switch/etc. | Shared sizes, keyboard semantics, focus, disabled and validation states. Avoid separate feature-local copies. |
| Transient layers | Shared Dialog/Popover/Menu/Sheet | Legible regular glass with bounded size, collision handling and focus restoration. |
| Notifications | Shared Sonner adapter and `.cn-toast` recipes | Frosted surface, status icon well, readable title/description, accessible close/action controls; top-right desktop, bounded mobile placement. |
| Loading | Shared Skeleton backed by `AsciiSkeleton` | Actual content geometry; task cards show title, body, badge and avatar placeholders instead of giant texture blocks. |
| Navigation motion | `lib/view-transition.ts` | Native feature-detected content crossfade, static sidebar, direct terminal/canvas changes, reduced-motion fallback. |

## Appearance preferences

The user explicitly requested Glass as the product's default material. Appearance offers **Glass**, **Follow system**, and **Solid**, stored on this device under `floq.material`. Follow system honors `prefers-reduced-transparency`; Solid is always opaque. Glass deliberately chooses the translucent appearance even if the OS requests reduced transparency. Forced-colors and missing-blur fallbacks remain available independently. This distinction matters on Windows, where the OS preference can otherwise make a glass design render fully opaque.

Runtime CSS is canonical. Light uses a silver base with peach illumination; dark uses graphite with silver and ember illumination. Flowless orange remains `#f97316`; high-contrast ink and hover/focus variants remain separate semantic roles. Glisse does not introduce a second theme provider or a parallel form/menu system.
