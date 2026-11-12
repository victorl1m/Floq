---
name: Floq
description: A focused workspace for running and directing coding agents.
colors:
  oled-black: "#000000"
  charcoal: "#1c1c1e"
  charcoal-raised: "#2c2c2e"
  pearl-background: "#e7e9ee"
  pearl-surface: "#fbfcfe"
  ink: "#202633"
  primary-orange: "#f97316"
  primary-orange-hover: "#ea580c"
  primary-orange-text-light: "#b54708"
  primary-orange-foreground: "#211007"
  text-dark: "#f5f5f7"
  secondary-text-dark: "#98989d"
  border-dark: "#38383a"
typography:
  display:
    fontFamily: "Geist Variable, SF Pro Display, system-ui, sans-serif"
    fontSize: "48px"
    fontWeight: 500
    lineHeight: 1.06
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Geist Variable, SF Pro Text, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: "-0.045em"
  body:
    fontFamily: "Geist Variable, SF Pro Text, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist Variable, SF Pro Text, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.35
  mono:
    fontFamily: "Geist Mono Variable, SF Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  nav: "10px"
  control: "12px"
  compact-card: "16px"
  dialog: "18px"
  settings-dialog: "22px"
  canvas-card: "14px"
  workspace: "22px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary-orange}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.control}"
    height: "36px"
    padding: "0 12px"
  sidebar-selection:
    backgroundColor: "{colors.charcoal-raised}"
    textColor: "{colors.text-dark}"
    rounded: "{rounded.nav}"
    height: "32px"
  dialog-dark:
    backgroundColor: "{colors.charcoal}"
    textColor: "{colors.text-dark}"
    rounded: "{rounded.dialog}"
  sidebar-search:
    backgroundColor: "{colors.charcoal}"
    textColor: "{colors.text-dark}"
    rounded: "{rounded.nav}"
    height: "36px"
    padding: "0 10px"
  canvas-agent-card:
    backgroundColor: "{colors.charcoal}"
    textColor: "{colors.text-dark}"
    rounded: "{rounded.canvas-card}"
---

# Floq interface design

## North star

Floq is a focused desktop workspace for directing coding agents. Keep the interface quiet and compact so terminal output, agent status, and user intent stay prominent.

## Visual register

- **Palette:** light mode uses cool pearl (`#e7e9ee`) with white content surfaces and ink (`#202633`). Dark mode is OLED black (`#000000`) with Apple charcoal surfaces (`#1c1c1e`, `#2c2c2e`) and white / secondary gray text. Flowless orange (`#f97316`) marks primary actions and useful emphasis; selection is neutral. Status colors stay semantic.
- **Typography:** use the existing Geist Variable sans stack for interface text and Geist Mono for code and numeric data. Use a clear scale: page headings 28–32 px, dialog headings 16–20 px, controls and dense data 13–14 px.
- **Density and shape:** preserve compact project navigation (32 px project/workspace rows and 28 px agent rows) and stable utility-action slots. Use rounded rectangles with a deliberate hierarchy: 20–24 px workspace panels, 18–24 px dialogs, 10–12 px fields and controls, and 10 px navigation rows. Keep row geometry stable on hover, selection, and keyboard focus.
- **Surfaces:** keep the root and workspace canvas flat. Use lightweight translucent fills and static highlights for broad planes such as the sidebar, composer, settings groups, and canvas cards. The sidebar Search trigger uses a restrained translucent tint over native Mica/Acrylic, with an opaque fallback when transparency is reduced. Floating menus use a bounded 10 px CSS backdrop blur; dialog surfaces use 8 px, except the expanded terminal shell, whose viewport remains unblurred and whose content stays opaque. The full-window scrim remains a flat dim layer. Avoid pixel-map refraction on full-window shells and large, continuously recomposited blur layers. The active left navigation row stays flat; hover and keyboard focus remain distinct.
- When native Mica, Acrylic, or vibrancy is active, the canvas plane, canvas floating controls and editable canvas fields, and right sidebar pane use theme-tinted translucent fills that reveal the native material. Canvas nodes/cards, sidebar controls, terminals, dialogs, and menus remain opaque. Solid preference, OS reduced-transparency, and forced-colors use opaque fallbacks.
- **Notifications:** use one Sonner stack at the top center, below the native titlebar. Toasts use the same restrained pearl / charcoal translucent material and local 10 px blur as menus, with semantic status icons, clear text, compact actions, and natural wrapping. Keep the standard live-region, dismissal, action, and timeout behavior. On narrow screens, stay inside the safe area and available width.
- **Icons:** use Tabler icons and shared provider marks. Icons explain an action or model choice and retain accessible names on icon-only controls.
- **Motion:** preserve existing purposeful transitions only where they clarify state; do not add ambient movement. Respect OS and Floq reduced-motion settings.

## Token ownership

`src/index.css` owns the runtime theme variables and typography. Shared UI components under `src/components/ui` consume those tokens. Feature components should use semantic tokens and shared primitives instead of duplicating colors or control behavior.

## Interaction baseline

Controls use native button/link semantics where possible, visible keyboard focus, clear pointer affordance, and a meaningful disabled or loading state. Long dialog content scrolls inside a stable shell; paginated lists may load on scroll when the scroll container and retry state remain clear.

## Theme and runtime mapping

The runtime token source is `src/index.css` (Model B: runtime CSS is canonical; DESIGN.md mirrors accepted values). Light uses `#e7e9ee` / `#202633`; OLED dark uses `#000000` / `#f5f5f7`, with elevated surfaces `#1c1c1e` and `#2c2c2e`. Both themes use Flowless orange `#f97316` for primary actions; focus uses a clear orange ring (`#c2410c` light, `#ff9f0a` dark). Main text uses foreground tokens; orange is not used for selected navigation labels or rails. Cards, popovers, inputs, borders, and sidebar surfaces consume semantic variables. Floq-owned CSS surfaces use localized blur, static alpha fills and highlights independently of native window material. Solid and reduced-transparency fallbacks keep surfaces opaque and without blur. When native Mica/Acrylic/vibrancy is actually active, the canvas plane, its floating controls and editable fields, and the right sidebar pane get theme-matched translucent tints, while cards and unrelated controls remain opaque. Keep working content readable. Typography is Geist Variable for interface text and Geist Mono for code, terminal, and compact data.

Keep focus rings clearly visible against both themes. Shared loading placeholders use `AsciiSkeleton` from `ascii-reveal`; data that has arrived can enter with `AsciiReveal`. Preserve final content geometry, keep dense placeholders still by default, and honor both OS and Floq reduced motion. Native Mica, Acrylic, and vibrancy follow the OS transparency preference where supported; Solid is opaque. All materials use accessible forced-color fallbacks, and browsers without backdrop-filter get an opaque surface. Do not add ambient movement behind working surfaces.

## Home composer

The composer is the primary home action. Keep its project, workspace, provider, model, and send controls in the existing shared flow. Prompt starter cards insert editable text into the composer and move focus there; they never submit directly and stay inert while a draft exists. The prompt field has a programmatic label and a stable help/status description.

## Project navigation

Use the supplied Orca sidebar reference for density and hierarchy: 32 px project and workspace rows, 28 px agent rows with 4 px between agents, shallow indentation without tree rails, muted branch icons, and a small primary-checkout badge. Retain the existing semantic theme tokens and provider marks. Project, workspace, and folder disclosure state is saved per runtime and user; unseen entries remain expanded by default. Workspace rows provide a direct New agent action that selects the exact project and branch before opening the shared composer. Only the hovered row reveals its utility actions; keyboard focus and open menus reveal them too, and touch keeps them visible. Refresh failures sit below the retained project list with Retry. The terminal split toolbar control is temporarily hidden. The left sidebar starts with an organization block (rounded avatar, bold name, role line, chevron) above Search; it opens the organization list and alone carries a decorative dithered 2 px pixel-dot mask clipped to its rounded bounds (densest top-right), and a matching band fades up from the sidebar footer edge. Both use the `--sidebar-pixel` alpha token, sit under content, and are hidden under reduced transparency and forced colors.

The project canvas puts its toolbar (project identity, Wake all, Vault, New agent, canvas tools) in the app titlebar and inherits titlebar chrome; a Changes pill sits at the centre of the titlebar slot and opens the Changes dialog; the tool groups and actions occupy the third track, aligned to the end (`justify-self:end`), after project identity on the left. Equal side tracks keep the pill centred; tools fold into a Canvas tools menu before space becomes tight, and narrow slots use natural action widths to avoid overlap. Vault and New agent always stay visible.

Canvas selection is neutral: the selected-node halo and the marquee rectangle use foreground tokens, never orange or provider accents. Shift/Cmd/Ctrl marquee adds to the selection, and Esc or a pane click clears notes, keychains and app windows as well as agents. App windows are canvas nodes (one per running display), resizable when selected. The right sidebar has Files and Artifacts tabs; files open in a document preview dialog and are created inline in the tree. Below 1024 px the right sidebar overlays the workspace with a tinted, mostly opaque fill and no blur plane.

Agent identity is a Floq avatar: a flat blob with two white eyes, drawn as inline SVG by `src/lib/robot-avatar.ts` and seeded by the session UUID (same seed, same avatar; only append to its tables). Nine original shapes (orb, drop, peak, cloud, pill, clover, tile, wave, bean), six eye styles, a slight tilt and an optional specular highlight (24 px and up only), on a ten-colour palette led by Floq orange (#FF8A08). No outline, gradient or mouth. The provider logo is a small disc fully inside the bottom-right corner, ringed in the surrounding surface colour and never over the eyes; Settings > Appearance > Robot avatars off shows the provider logo alone. The agent card header carries avatar, title, a state label (Running, Starting, Sleeping, Exited, Failed; no status dot), role chips (icon + capitalized label; Orchestrator and Subagent share one chip style), and a trailing Open action; linking is done by dragging between handles or the canvas toolbar, with no per-card link button or "in context" chip.

Primary navigation order is Home, Tasks, Skills & MCP, Secrets, Terminal. Enabled plugin views follow Terminal below a separator. Tasks is an organization workspace; keep task boards within the established compact, token-based surface language. Skills & MCP is a first-class workspace view; keep the terminal panel mounted but hidden while another view is active so terminal scrollback survives navigation.

The account menu owns the active organization scope shared with Tasks. Show the selected organization in the account card and switch it through the menu; validate persisted selections against the organizations available to the signed-in user. Keep account preferences and the global sidebar state scoped to the runtime and user. Treat local storage as optional and avoid storing credentials there.

An organization is a partition of the signed-in user's own projects, not shared access: every user has an always-present Personal organization (cannot be renamed, left, deleted or invited to) and each project belongs to exactly one organization. Switching organization, from any entry point, runs one flow in the runtime store: the client sends `X-Floq-Organization` on every request, projects and sessions are cleared and in-flight responses from the old organization are dropped, open canvas and session views go home, the folder cache is keyed by organization, and the last canvas is restored per organization if it exists there. Running agents keep running while hidden. Switcher components never carry switch logic. Empty states in an organization say projects created there belong to it. Adding a repository that already exists in another organization offers Switch to that organization or Move here. Sharing projects between members is future work (sandboxes and files are per user). Personal organizations have a NULL slug and the `personal-` slug prefix is reserved. By design, session-id routes (`/v1/sessions/:id/*`, files, artifacts, ports) and the `/v1/events` WebSocket are not organization-scoped: they are always the same user's, so events of sessions in other organizations still stream and clients filter by `session.organizationId`. Agent-facing `/internal` routes (`floq list|ask|link|skills|mcp|projects`) are scoped to the caller's organization and refuse another organization's agents or projects with `cross_org_disabled`. Rollback: an older runtime inserts `user_project_folders` rows by `(user_id)` alone; a trigger fills the organization, but its `ON CONFLICT (user_id)` finds no matching constraint after the primary key became `(user_id, organization_id)`, so downgrading needs manual SQL for folders. `floq_projects.organization_id` is `ON DELETE RESTRICT`: reassign projects before deleting an organization or user outside the runtime.

Tasks uses the app titlebar for a compact, horizontally scrollable board tab strip matching agent tabs. Tabs open on demand, close independently, and keep an active selection; keyboard arrows move between tabs, while B opens the searchable board picker. The picker groups Favorites, Recent, and All boards; searches show a single deduplicated result group and the organization selector changes the shared account organization scope. Persist favorites, recents, open tab IDs, and active board per runtime, user, and organization. Validate every restored board ID against the server's authorized list; preserve an intentionally empty tab set and never open every board automatically. Keep the mobile picker in a bounded dialog. The board canvas uses compact horizontal lists and card stacks. Desktop cards can be dragged between lists; the card detail List selector provides the same move for keyboard and touch users. Card details own editing, assignment, due dates, and deletion. Put infrequent create, invite, join, rename, and destructive actions in focused shared dialogs or menus. Performance preferences are device-local: explain immediate scrollback trimming and the coarse memory hint in the setting copy; reduced background refresh changes polling only while the window is hidden.

Task source navigation is composed through the same slot in desktop and mobile navigation. Future providers such as Movidesk or Azure DevOps should add a source group with a stable source ID, label, and view render slot, then display only real data the user is authorized to access. Keep provider authentication and data loading inside that provider's implementation; do not add placeholder sources or mix external tickets into native board results.

The required sign-in dialog offers a dedicated invitation registration panel without changing public signup policy. Keep token entry in transient form state, use the shared auth field and validation patterns, and cap the dialog height so the content scrolls on short or narrow viewports. Existing accounts sign in and accept the invitation through the same dialog flow.

Workspace rows reserve fixed space for disclosure and worktree menu buttons, including when hidden. Long branch names truncate before these controls; row-specific padding and action offsets take precedence over shared sidebar defaults.

Terminal sessions accept dragged files and a keyboard-accessible picker. Keep upload feedback compact and token-based; show per-file progress/errors while preserving valid files in a mixed selection. Limit files to 4 MiB each, 16 MiB total, and 20 files per drop. Save attachments in the user's private runtime storage outside the checkout, then paste shell-quoted absolute paths into the terminal without executing them. Drag and drop must keep the picker alternative.

## Plugins

- Plugins extend Floq through declared contribution points only. They never restyle core surfaces or change core navigation order.
- **Navigation:** primary order stays Home, Tasks, Skills & MCP, Secrets, Terminal. Enabled plugin views follow below a separator, in plugin-name order, using 32 px rows and Tabler icons. They behave like core simple views: the terminal stays mounted and hidden, and history covers them.
- **Task sources:** each enabled source is one source group in the Tasks board picker (stable source ID, label, view slot), as already anticipated in "Project navigation". A source shows only data the user is authorized to see, never mixes into native board results, and needs no placeholder sources.
- **Settings:** plugin enablement and configuration live in Settings > Plugins. Credentials are vault secrets referenced by name and are never typed into plugin settings.
- **Surfaces:** plugin views use `PluginPage` and the plugin kit (`src/plugins/kit`). Plugin views follow the same material, blur and opacity rules as core pages, and plugins add no new blur layers or ambient motion.
- **Failure:** a failing plugin shows its own contained error state, and the rest of Floq stays usable.
