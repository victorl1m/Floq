# UI system rework notes

## Research inventory

| Source | Evidence | Decision |
| --- | --- | --- |
| Floq `src/index.css`, shared UI primitives, and Home/Tasks/Skills/Secrets screens | Existing Tailwind v4 semantic tokens and Radix-backed shared recipes; Home is the session creation entry point | Retain the runtime token system and screen interaction owners; update shared recipes instead of adding feature-local systems |
| [Flowless](https://flowless.app/) | User-designated orange action treatment, exact color `#f97316` | Use Flowless orange for primary actions in both themes; add high-contrast `primary-text`, `primary-hover`, and focus mappings separately |
| Installed `ascii-reveal@0.3.0` README and public types | `AsciiSkeleton` provides geometry-preserving glyph blocks and `AsciiReveal` decodes arrived content; OS reduced-motion is built in | Adapt the real components through shared `Skeleton` and `FloqReveal`; keep dense skeletons still and disable reveal for Floq reduced motion |
| Premium frontend canonical ownership and token mapping references | Runtime CSS remains canonical; existing primitives and routes own behavior | Added a canonical interaction map in `UX-CONTRACT.md`; keep changes API-compatible and preserve runtime contracts |
| Haiku static audit and parent browser review | Found input autocomplete override, weak/low-contrast focus and primary token mapping, skeleton footprint issues, and command dialog title placement; Home was checked at desktop and 390px with no console errors | Fixed autocomplete spread precedence; strengthened shared focus and input borders; corrected CommandDialog naming; retained Home composer flow and responsive layout |

## Decisions

- Retained the graphite/soft-white themes and Geist stack, with restrained translucent CSS surfaces and opaque fallbacks.
- Kept the Home composer as the single session creation path. Prompt cards only populate and focus the editable field, and remain inert while a draft exists.
- Reworked loading and empty states in Skills and Secrets through the shared `AsciiSkeleton`, `AsciiReveal`, and Empty owners.
- Updated shared controls for consistent elevation, collision bounds, selected states, focus, disabled behavior, and keyboard-safe popovers without changing their APIs.

## Drift addressed

| Existing rule or behavior | Evidence | Action |
| --- | --- | --- |
| Semantic CSS variables own ordinary UI colors | `src/index.css` was grayscale and lacked the selected Flowless accent and glass mapping | Added orange and translucent-surface tokens with light/dark high-contrast text and fallback states |
| Reduced motion is respected | Skeletons used generic pulse and loading markup did not share a character-grid owner | Replaced the CSS imitation with the real AsciiSkeleton adapter; dense placeholders are static, OS preference is library-owned, Floq preference is adapter-owned |
| Home composer is the primary action | The textarea had only a placeholder as its name and no quick starting paths | Added an explicit screen-reader label and prompt starters that fill/focus the existing textarea |
| Bootstrap should communicate loading while preserving shape | App bootstrap displayed a lone spinner | Added a compact geometry-preserving skeleton layout |

## Corrective visual pass

- Rebuilt Home as a left-aligned workspace with a labeled task composer, explicit Start agent action, real project rows, and prompt starters.
- Added a shared FloqSurface owner for local CSS surfaces. Warm peach/silver light materials and smoked dark materials use the Flowless orange accent.
- Earlier builds used Glass and Follow system preferences. The current device Material setting uses native Mica, Acrylic, or vibrancy where supported, with Solid and OS reduced-transparency fallbacks.
- Replaced Sonner defaults with custom frosted toast layout, semantic icon wells, readable messages, and accessible actions.
- Replaced Tasks loading slabs with fixed task-card geometry and actual ascii-reveal placeholders. Bootstrap now reserves the revised Home layout.
- Added feature-detected native workspace view transitions for Vite/Tauri, respecting reduced motion and keeping live terminal/canvas navigation direct.
- Darkened light-theme secondary and accent text after testing contrast over the translucent settings surface.

## Verification

- Production build and TypeScript check passed. Vite retains its large-chunk advisory.
- All 16 existing preference/project tests and four native view-transition tests passed. A staged-only checkout also passed TypeScript independently of the unrelated runtime changes.
- Thirteen browser workflow checks and a separate populated-sidebar visual check passed in isolated Chrome with synthetic runtime responses at 1440×1000 and 390×844. Coverage includes autofill, password visibility, composer focus, board search and intentionally empty tab persistence, actual ASCII skeleton geometry, search clearing, settings failure/retry, mobile navigation, OS/device reduced motion, and the populated sidebar defect.
- axe-core found zero WCAG A/AA violations on the five tested settled surfaces: sign-in password, dark Home, board picker, dark Secrets, and light Appearance settings. This is sampled automated coverage, not a complete accessibility certification.
- The settings test intentionally injects HTTP 503; its browser resource-error log is expected.
- The premium strict scanner still flags JSX/component patterns it cannot resolve. The original report is preserved in `ui-audit.json`, with source review and a JSX-aware form/textarea check in `ui-audit-reviewed.json`. No actual native form/textarea violations remain in that check. The strict scanner is not reported as passing.
- DESIGN.md lint reports zero errors and one warning because the maintained document has no YAML token frontmatter. Runtime CSS remains the documented token owner.
- Real provider authentication, session creation, server CRUD mutations, and Tauri-native window behavior were not exercised against a live runtime.
