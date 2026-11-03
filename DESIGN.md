# Floq interface design

## North star

Floq is a focused desktop workspace for directing coding agents. Keep the interface quiet and compact so terminal output, agent status, and user intent stay prominent.

## Visual register

- **Palette:** use the light and dark semantic CSS variables in `src/index.css`; do not add feature-specific brand colors for ordinary controls. Reserve status colors for status.
- **Typography:** use the existing system/Geist sans stack for interface text and Geist Mono for code and numeric data.
- **Density and shape:** favor compact rows, small utility controls, subtle borders, and the existing rounded-md/lg scale. Dialogs fit their content up to a viewport-height cap; long forms scroll in the body, with stable dimensions reserved for flows that explicitly need them.
- **Icons:** use Tabler icons and the shared provider brand marks. Icons must explain the action or model choice and retain an accessible text name on icon-only controls.
- **Motion:** use short state transitions only where they clarify change; respect reduced motion.

## Token ownership

`src/index.css` owns the runtime theme variables and typography. Shared UI components under `src/components/ui` consume those tokens. Feature components should use semantic tokens and shared primitives instead of duplicating colors or control behavior.

## Interaction baseline

Controls use native button/link semantics where possible, visible keyboard focus, clear pointer affordance, and a meaningful disabled or loading state. Long dialog content scrolls inside a stable shell; paginated lists may load on scroll when the scroll container and retry state remain clear.

## Project navigation

Use the supplied Orca sidebar reference for density and hierarchy: 32 px project and workspace rows, 28 px agent rows with 4 px between agents, shallow indentation without tree rails, muted branch icons, and a small primary-checkout badge. Retain the existing semantic theme tokens and provider marks. Project row clicks expand/collapse; workspace selection opens Home, while its disclosure toggles agents. Only the hovered row reveals its utility actions; keyboard focus and open menus reveal them too, and touch keeps them visible. Refresh failures sit below the retained project list with Retry. The terminal split toolbar control is temporarily hidden.

Primary navigation order is Home, Tasks, Skills & MCP, Secrets, Terminal. Tasks is a team workspace; keep task boards within the established compact, token-based surface language. Skills & MCP is a first-class workspace view; keep the terminal panel mounted but hidden while another view is active so terminal scrollback survives navigation.

The account menu owns the active team scope shared with Tasks. Show the selected team in the account card and switch it through the menu; validate persisted selections against the teams available to the signed-in user. Keep account preferences, the global sidebar state, and the Tasks board rail collapse scoped to the runtime and user. Treat local storage as optional and avoid storing credentials there.

Tasks uses a collapsible board rail, with the same searchable navigator in a mobile sheet. Keep its team selector, Favorites, Recent, and All boards compact; searching shows a single deduplicated result group. Favorites, recent boards, and the last permitted board are device-local preferences scoped by runtime, user, and team. Restore selection only after the server confirms access to that board. The board canvas uses compact horizontal lists and card stacks. Desktop cards can be dragged between lists; the card detail List selector provides the same move for keyboard and touch users. Card details own editing, assignment, due dates, and deletion. Put infrequent create, invite, join, rename, and destructive actions in focused shared dialogs or menus. Performance preferences are device-local: explain immediate scrollback trimming and the coarse memory hint in the setting copy; reduced background refresh changes polling only while the window is hidden.

Task source navigation is composed through the same slot in desktop and mobile navigation. Future providers such as Movidesk or Azure DevOps should add a source group with a stable source ID, label, and view render slot, then display only real data the user is authorized to access. Keep provider authentication and data loading inside that provider's implementation; do not add placeholder sources or mix external tickets into native board results.

The required sign-in dialog offers a dedicated invitation registration panel without changing public signup policy. Keep token entry in transient form state, use the shared auth field and validation patterns, and cap the dialog height so the content scrolls on short or narrow viewports. Existing accounts sign in and accept the invitation through the same dialog flow.

Workspace rows reserve fixed space for disclosure and worktree menu buttons, including when hidden. Long branch names truncate before these controls; row-specific padding and action offsets take precedence over shared sidebar defaults.
