# Component and material system

## References

- [Apple Design Resources](https://developer.apple.com/design/resources/) and [Materials](https://developer.apple.com/design/human-interface-guidelines/materials): use materials to express hierarchy, keep foreground information legible, distinguish native window material from content surfaces, and avoid layering expressive effects everywhere.
- [ascii-reveal](https://github.com/quanhoangindex/ascii-reveal): real ASCII placeholders and short content reveals.
- The user's supplied dark task card, frosted light panels, smoked wallet, and warm translucent desktop dashboard references guide appearance. The generated desktop mockup guided the corrective layout pass; it is a design reference, not a shipped bitmap UI.

## Shared owners

| Layer | Canonical owner | Treatment |
| --- | --- | --- |
| Workspace | `.workspace-surface`, `src/index.css` | Stationary warm peach/ember and silver light fields that remain visible through materials. |
| Navigation and chrome | Shared Sidebar, titlebar and footer | Light translucent CSS fill over native material, clear selection, no ornamental selection rails. |
| Key interactive surface | `ui/floq-surface.tsx` | Floq-owned opaque wrapper using semantic CSS surfaces; used for the task composer. |
| Content | Shared Card, `.material-content` | Thicker frosted fill with restrained depth; readable task and table content. |
| Controls | Existing shadcn Button/Input/Select/Switch/etc. | Shared sizes, keyboard semantics, focus, disabled and validation states. Avoid separate feature-local copies. |
| Transient layers | Shared Dialog/Popover/Menu/Sheet | Legible translucent surfaces with bounded blur, collision handling and focus restoration. |
| Notifications | Shared Sonner adapter and `.cn-toast` recipes | Frosted surface, status icon well, readable title/description, accessible close/action controls; top-right desktop, bounded mobile placement. |
| Loading | Shared Skeleton backed by `AsciiSkeleton` | Actual content geometry; task cards show title, body, badge and avatar placeholders instead of giant texture blocks. |
| Navigation motion | `lib/view-transition.ts` | Native feature-detected content crossfade, static sidebar, direct terminal/canvas changes, reduced-motion fallback. |

## Appearance preferences

Native Mica, Acrylic, Vibrancy and Solid preferences control the OS window material where supported. Floq CSS surfaces are separate and retain reduced-transparency and forced-color fallbacks.

Runtime CSS is canonical. Light uses a silver base with peach illumination; dark uses graphite with silver and ember illumination. Flowless orange remains `#f97316`; high-contrast ink and hover/focus variants remain separate semantic roles.
