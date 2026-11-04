# Floq UI research and review

Research roles: Claude Haiku audited repository design files and interaction patterns; the parent agent set the design direction and reviewed behavior; GPT-6 Luna implemented the shared component system. Research was completed against the working tree, including the first implementation pass.

## Primary reference

- [ascii-reveal live demo](https://quanhoangindex.github.io/ascii-reveal/)
- [Official integration, accessibility, and theming guidance](https://github.com/quanhoangindex/ascii-reveal/blob/main/README.md)
- Installed `ascii-reveal@0.3.0`; its shipped TypeScript definitions are the API reference.
- [Flowless](https://flowless.app/) supplies the requested brand accent. Its public CTA and styling use `#f97316`, with `#fb923c` highlights.

The demo uses graphite and soft-white surfaces, Geist and Geist Mono, thin borders, restrained translucent layers, and rounded controls. Transfer those visual relationships into Floq's compact workspace rather than copying the marketing page's spacing or content. The user's later instructions replace the reference's blue with Flowless orange and make glass surfaces an explicit design requirement. Runtime CSS variables remain canonical; shared shadcn recipes consume them. Orange solid buttons use dark ink; a darker orange text token protects small-text contrast in light mode.

Use the actual `AsciiSkeleton` for placeholders and `AsciiReveal` for bounded content arrivals. Keep forms, toolbars, terminals, and continuously updating output usable. The library retains real content in the DOM and renders its effect above it; mark interactive subtrees to skip where appropriate. Respect system and Floq reduced-motion preferences. Long lists use static skeletons to avoid a canvas animation per row. Initial loading, background refresh, empty results, and failures are different states.

## Haiku audit findings and implementation direction

The requested `find-skills` search identified `gpt-taste` and glass-design guidance. Loaded `gpt-taste` from `tasteskill/tasteskill` (the current `leonxlnx/taste-skill` checkout exposes only `design-taste-frontend` despite the catalog listing), and `glass-dark-ui` from `mengto/skills`. These are installed in the user's Codex skills directory for future turns. Applied their relevant guidance with the existing frontend-design skills: deliberate spacing, no nested decorative boxes, no fake micro-labels, restrained frosted charcoal layers, subtle edge highlights, and readable opaque fallbacks. The supplied reference, actual app workflows, and explicit Flowless branding remain authoritative.

| Finding | Evidence / owner | Direction |
| --- | --- | --- |
| Caller autocomplete overwritten, including saved-password autofill | Shared Input | Preserve explicit autocomplete values. |
| Transparent primary hover reduces white-text contrast | Shared Button | Use solid theme-aware hover tokens. |
| Field borders and composer focus too faint | Runtime input/ring tokens, Home | Increase contrast and use consistent focus treatment. |
| Generic or text-only loading across screens | Tasks, project sidebar, Skills, Secrets, settings | Match real content geometry with the shared ASCII skeleton. |
| Skeleton imitation does not implement the reference | Shared Skeleton | Integrate the actual library as explicitly requested. |
| OS reduced-motion treatment incomplete | Global CSS, spinner and pulse uses | Apply OS and device preference throughout. |
| Mobile board-create button has no accessible name | Tasks toolbar | Add an explicit action name. |
| Generic containers have ignored accessible labels | Task board/member region, Home starters | Give containers the appropriate region/group semantics. |
| Agent state dot lacks accessible role | Project sidebar | Expose the state as a named image. |
| Selected sidebar rows show ornamental orange stripes | Shared Sidebar recipe; user's populated-sidebar screenshot | Remove the stripes, keep selection through surface/text, and verify real icon bounds and focus visibility. |
| Folder disclosure misses keyboard visibility | Project sidebar group selector | Reveal disclosure on focus within the row. |
| Settings controls need explicit label association | Appearance and agent preferences | Associate labels with triggers, switches, and sliders. |
| Settings load failure leaves a spinner indefinitely | Settings dialog | Keep a persistent inline failure with Retry. |
| Global search promises projects but does not list them | Command palette | Include real authorized projects and every main destination; clear search restores input focus. |
| Board tabs ignore restored choices and open every board | Tasks navigation preferences | Validate saved IDs, preserve intentionally empty tabs, open boards on demand, and add search/favorites. |
| Mobile navigation remains open after selection | App sidebar | Close the drawer after destination selection. |
| Font stack puts SF fonts before documented Geist | Runtime font aliases | Make Geist the primary family. |

## Verification boundaries

Browser checks use an isolated headless Chrome context with synthetic runtime responses. They exercise presentation, keyboard behavior, failure feedback and responsive layout without accessing real credentials or mutating a runtime. They do not prove a real provider session can start.

The premium static audit is retained in `ui-audit.json`. Its HTML-like scanner also treats capitalized React `Select`, `Button`, and `Textarea` names as native tags and cannot infer Radix `asChild`, prop-forwarded actions, or some JSX handler attributes. These findings require source/runtime review; they must not be hidden by changing declared ownership or disabling working controls. Browser accessibility checks use axe-core against settled UI states; entrance/exit animation frames must finish before measuring contrast.
