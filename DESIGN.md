# Floq interface design

## North star

Floq is a focused desktop workspace for directing coding agents. Keep the interface quiet and compact so terminal output, agent status, and user intent stay prominent.

## Visual register

- **Palette:** use the light and dark semantic CSS variables in `src/index.css`. The Flowless reference supplies the brand orange `#f97316`; pair it with ink on solid actions and use the separate high-contrast `primary-text` token for text. Keep status colors semantic.
- **Typography:** use the existing system/Geist sans stack for interface text and Geist Mono for code and numeric data.
- **Density and shape:** favor compact rows, small utility controls, subtle borders, and the existing rounded-md/lg scale. Dialogs fit their content up to a viewport-height cap; long forms scroll in the body, with stable dimensions reserved for flows that explicitly need them.
- **Icons:** use Tabler icons and the shared provider brand marks. Icons must explain the action or model choice and retain an accessible text name on icon-only controls.
- **Motion:** use short state transitions only where they clarify change; respect reduced motion.

## Token ownership

`src/index.css` owns the runtime theme variables and typography. Shared UI components under `src/components/ui` consume those tokens. Feature components should use semantic tokens and shared primitives instead of duplicating colors or control behavior.

## Interaction baseline

Controls use native button/link semantics where possible, visible keyboard focus, clear pointer affordance, and a meaningful disabled or loading state. Long dialog content scrolls inside a stable shell; paginated lists may load on scroll when the scroll container and retry state remain clear.

## Theme and runtime mapping

The runtime token source is `src/index.css` (Model B: runtime CSS is canonical; DESIGN.md mirrors accepted values). The light theme uses `#e8e8ec` and `#141416`; dark surfaces use graphite `#141418` with soft white `#ededef`. Both themes use Flowless orange `#f97316` for primary actions, with dark ink `#211007` on solid orange. Light focus uses darker orange `#c2410c`; dark focus uses `#fb923c`. Text uses `primary-text` (`#b54708` light, `#fb923c` dark) for contrast. Cards, popovers, inputs, borders, and sidebar surfaces use semantic variables. Shared glass surfaces use `--glass-surface`, `--glass-border`, `--glass-highlight`, and `--glass-shadow`; keep opacity restrained and text fully legible. Typography is Geist Variable for interface text and Geist Mono for code, terminal, and compact data.

Keep focus rings clearly visible against both themes. Shared loading placeholders use `AsciiSkeleton` from `ascii-reveal`; data that has arrived can enter with `AsciiReveal`. Preserve final content geometry, keep dense placeholders still by default, and honor both OS and Floq reduced motion. Glass surfaces fall back to opaque surfaces when blur is unavailable, transparency is reduced, or forced colors are active. Do not add ambient movement behind working surfaces.

## Home composer

The composer is the primary home action. Keep its project, workspace, provider, model, and send controls in the existing shared flow. Prompt starter cards insert editable text into the composer and move focus there; they never submit directly and stay inert while a draft exists. The prompt field has a programmatic label and a stable help/status description.

## Project navigation

Use the supplied Orca sidebar reference for density and hierarchy: 32 px project and workspace rows, 28 px agent rows with 4 px between agents, shallow indentation without tree rails, muted branch icons, and a small primary-checkout badge. Retain the existing semantic theme tokens and provider marks. Project, workspace, and folder disclosure state is saved per runtime and user; unseen entries remain expanded by default. Workspace rows provide a direct New agent action that selects the exact project and branch before opening the shared composer. Only the hovered row reveals its utility actions; keyboard focus and open menus reveal them too, and touch keeps them visible. Refresh failures sit below the retained project list with Retry. The terminal split toolbar control is temporarily hidden.

Primary navigation order is Home, Tasks, Skills & MCP, Secrets, Terminal. Tasks is an organization workspace; keep task boards within the established compact, token-based surface language. Skills & MCP is a first-class workspace view; keep the terminal panel mounted but hidden while another view is active so terminal scrollback survives navigation.

The account menu owns the active organization scope shared with Tasks. Show the selected organization in the account card and switch it through the menu; validate persisted selections against the organizations available to the signed-in user. Keep account preferences and the global sidebar state scoped to the runtime and user. Treat local storage as optional and avoid storing credentials there.

Tasks uses the app titlebar for a compact, horizontally scrollable board tab strip matching agent tabs. Tabs open on demand, close independently, and keep an active selection; keyboard arrows move between tabs, while B opens the searchable board picker. The picker groups Favorites, Recent, and All boards; searches show a single deduplicated result group and the organization selector changes the shared account organization scope. Persist favorites, recents, open tab IDs, and active board per runtime, user, and organization. Validate every restored board ID against the server's authorized list; preserve an intentionally empty tab set and never open every board automatically. Keep the mobile picker in a bounded dialog. The board canvas uses compact horizontal lists and card stacks. Desktop cards can be dragged between lists; the card detail List selector provides the same move for keyboard and touch users. Card details own editing, assignment, due dates, and deletion. Put infrequent create, invite, join, rename, and destructive actions in focused shared dialogs or menus. Performance preferences are device-local: explain immediate scrollback trimming and the coarse memory hint in the setting copy; reduced background refresh changes polling only while the window is hidden.

Task source navigation is composed through the same slot in desktop and mobile navigation. Future providers such as Movidesk or Azure DevOps should add a source group with a stable source ID, label, and view render slot, then display only real data the user is authorized to access. Keep provider authentication and data loading inside that provider's implementation; do not add placeholder sources or mix external tickets into native board results.

The required sign-in dialog offers a dedicated invitation registration panel without changing public signup policy. Keep token entry in transient form state, use the shared auth field and validation patterns, and cap the dialog height so the content scrolls on short or narrow viewports. Existing accounts sign in and accept the invitation through the same dialog flow.

Workspace rows reserve fixed space for disclosure and worktree menu buttons, including when hidden. Long branch names truncate before these controls; row-specific padding and action offsets take precedence over shared sidebar defaults.

Terminal sessions accept dragged files and a keyboard-accessible picker. Keep upload feedback compact and token-based; show per-file progress/errors while preserving valid files in a mixed selection. Limit files to 4 MiB each, 16 MiB total, and 20 files per drop. Save attachments in the user's private runtime storage outside the checkout, then paste shell-quoted absolute paths into the terminal without executing them. Drag and drop must keep the picker alternative.
