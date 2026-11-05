# Floq UX contract

This file records durable interaction ownership for the desktop coding-agent workspace. `DESIGN.md` owns visual language; runtime semantic tokens live in `src/index.css`.

## Canonical UI map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Theme, Floq surfaces, typography, focus, reduced motion | `src/index.css` plus shared `src/components/ui/floq-surface.tsx`, `dialog.tsx`, and `alert-dialog.tsx` | `DESIGN.md` maps to runtime CSS tokens | Pearl / OLED; compact controls; static translucent broad planes; solid/system fallback | Contrast, keyboard focus, theme, forced colors, reduced-transparency and motion checks |
| Buttons and toggles | Shared recipes in `src/components/ui/button.tsx`, `switch.tsx`, `checkbox.tsx`, and `toggle.tsx` | `DESIGN.md` and this contract | Solid / outline / ghost; shimmer stays opt-in; checked / unchecked / disabled | Keyboard, selected, disabled, contrast, reduced-motion, fallback and shimmer geometry checks |
| Form | `src/components/ui/input.tsx`, `textarea.tsx`, `field.tsx`, and project form schemas | Feature form schema plus shared field primitives | Create / edit; field-specific input types | Label and error association, validation, submit and failure flows |
| Select/Listbox | Authored Radix owner in `src/components/ui/select.tsx` | This contract; `DESIGN.md` for visual tokens | Authored Radix select by default; `native-select.tsx` only where OS-owned popup behavior is accepted | Keyboard, selection, collision and popup sizing |
| Date | Native date input in the Tasks form | Business requirement and this contract | Native date popup, local date-only value | Keyboard, value round-trip, locale/runtime check |
| Cards, tables, empty states | Shared recipes in `src/components/ui/card.tsx`, `table.tsx`, and `empty.tsx` | `DESIGN.md` and this contract | Default / compact; dataset empty / no results / failure | Representative loading, empty, populated, and responsive states |
| Dialog, alert dialog, sheet, popover, menus, tooltip | Shared Radix owners under `src/components/ui` | This contract and `DESIGN.md` | Modal / alert / sheet; anchored menus and popovers | Focus, Escape, collision, short viewport, keyboard behavior |
| Loading and data reveal | `src/components/ui/skeleton.tsx` (`AsciiSkeleton`, `AsciiReveal`) | This contract; performance preference controls motion | Static dense placeholders; short reveal for arrived content | Reduced motion, geometry, delayed load and data replacement |
| Toast | `sonner` via `src/components/ui/sonner.tsx` and `App.tsx` | This contract | One top-center stack below the titlebar; success / warning / info / error / loading; optional actions | Safe-area and viewport fit, live region, keyboard focus, dismissal, stack and action review |
| CRUD | Screen workflow plus `src/lib/runtime/client.ts` | Runtime API and screen-owned business rules | Create / edit / delete, with existing confirmation flow | Success, failure, retry, and authorized API behavior |
| Scrollbar | Global application stylesheet in `src/index.css` | `DESIGN.md` | Theme-aware global surface; documented geometry exceptions | Visible, keyboard-operable, theme and forced-colors check |
| Home agent composer | `src/components/home/home-view.tsx` | This contract and runtime API | Prompt starter / custom draft; project/workspace/provider/model | Starter fill/focus, no draft replacement, Enter/Shift+Enter, IME, busy/error states |
| Agent and terminal workspaces | Existing runtime and terminal components | Runtime contracts | Session / shell view | Preserve terminal mounting, scrollback, authentication, payloads, and server lifecycle |

## State and feedback

- Initial bootstrap, refresh, and mutations must be perceivable without hiding usable content or changing primary control dimensions.
- Disabled and busy controls remain named; async failures retain entered values and use the shared toast or inline error owner.
- Empty states should explain the missing content and provide the next permitted action.
- Respect both `prefers-reduced-motion` and the device-local Floq reduced-motion preference. Neither setting changes product behavior.
- The opt-in primary-action shimmer is decorative, stays out of the label/icon layer, and stops for disabled or busy actions, reduced motion, forced colors, and the solid material preference.
- Large dialogs, canvas cards, composers, and sidebars use static translucent fills and highlights. The expanded terminal body stays opaque.
- When native Mica/Acrylic/vibrancy is active, tint the canvas plane, canvas topbar, editable canvas fields, and right-sidebar pane with theme-matched translucent fills; keep canvas cards, sidebar controls, and terminal content opaque. Solid material, OS reduced-transparency, and forced-colors must restore opaque fills.
- Floating menus and ordinary dialogs may use bounded standard CSS backdrop blur (10px for menus, 8px for dialogs) to separate text from content underneath. Keep the full-screen scrim unblurred and exclude the expanded terminal shell; the terminal toolbar may remain visually distinct while terminal output stays opaque. `solid`, `system` with reduced transparency, unsupported browsers, and forced-colors use opaque/no-blur fallbacks.
- Sonner toasts use a bounded CSS blur with native material enabled, and use opaque surfaces for Solid, OS reduced-transparency, unsupported-browser, and forced-colors fallbacks. Position the single toast stack at the top center, below the native titlebar and inside the mobile safe area. Preserve Sonner's live-region, action, dismissal, and timeout behavior; titles and descriptions wrap instead of truncating recovery details.
- Do not store credentials in new UI preferences or local composer state.

## Scope boundary

Visual changes must not alter provider authentication, runtime request/response shapes, session creation semantics, terminal mounting, or server lifecycle. New navigation and screen-specific interaction owners require an explicit contract update before implementation.
