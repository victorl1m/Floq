# Memory screen redesign: reference research

Ideas only. No assets or code copied. Items marked (verified) were confirmed in docs/search results; the rest come from general knowledge of the product and should be checked against the live product before anyone cites them.

## References

1. **Obsidian graph view** (verified): https://obsidian.md/help/Plugins/Graph+view
   - Hovering a node highlights its connections and fades the rest. We take this neighbor focus and dimming.
   - Color groups are a query plus a color. We take "color by group" with a small legend.
   - The default highlight vanishes on mouse-out. Plugins add click-to-pin (Esc clears), so we make selection sticky and hover transient.

2. **Obsidian Graph Legend / Highlight Lock plugins** (verified): https://community.obsidian.md/plugins/graph-legend
   - A legend lists the groups, and pointing at an entry highlights its nodes. We take a compact legend that doubles as a group filter.

3. **Neo4j Bloom / Aura Explore** (verified): https://neo4j.com/docs/aura/explore/explore-visual-tour/styling/
   - Rule-based styling covers color, size and caption, and the first matching rule wins. We take a deterministic color-by-group rule, with size scaled by link count or recency.
   - The caption has configurable placement and size. We take labels below the node, shown only at zoom or on focus, to limit clutter.

4. **Neo4j legend panel** (verified): https://neo4j.com/docs/aura/explore/explore-visual-tour/legend-panel/
   - The legend sits beside the scene and edits styles in place. We take a small floating legend with group counts.

5. **Kumu** (not re-verified): https://kumu.io
   - Maps use decoration by attribute, a focus mode that shows N-degree neighbors, and a side panel for the selected item. We take the neighbor-depth focus and a docked detail panel.

6. **Heptabase** (not re-verified): https://heptabase.com
   - Cards sit on a calm whiteboard with soft rounded containers and a muted palette. We take the soft rounded look and the card-first detail view.

7. **Logseq graph view** (not re-verified): https://logseq.com
   - Plain filled discs with thin straight edges, labels that scale with zoom, and orphan filtering. We take zoom-scaled labels and a "hide orphans" toggle.

8. **Linear (dark UI)** (not re-verified): https://linear.app
   - Low-contrast surfaces, a single accent color, 1px hairline borders, relative dates ("3d ago") with the absolute date on hover, and tight list rows with a clear title/meta hierarchy. We take all of these for the list and detail panel.

9. **Raycast** (not re-verified): https://www.raycast.com
   - Keyboard-first list with a detail pane on the right, subtle selection pill, and quiet empty states with one hint line. We take list navigation with arrow keys and Enter, plus the empty-state tone.

10. **Dribbble "knowledge graph" shots** (browsing only, nothing copied): https://dribbble.com/search/knowledge-graph
    - Dark canvases with softly glowing nodes and faint curved edges are the dominant pattern. We take the glow-on-focus idea, kept restrained.

## Chosen direction

- **Nodes:** soft discs in the Floq palette (`src/lib/robot-avatar.ts`): decision = Floq orange `#FF8A08` (lead), fact = sky, procedure = teal, episode = violet. A stage-coloured cut-out rim keeps touching discs apart; pinned adds an outer ring, forgotten is hollow and dashed, groups are tinted bubbles with a count. Size grows gently with links, length and pinning.
- **Edges:** thin, muted quadratic curves that always bend to the same side for a pair; weight sets width and opacity. On hover or selection the node's links take its endpoint colours (gradient). Supersedes links are dashed orange curves with an arrow head.
- **Background:** the agent canvas plane with its dot grid, panning and zooming with the graph, in light and dark.
- **Focus:** hover and selection add a soft glow and dim non-neighbours; selection is sticky (Esc closes the detail pane), hover is transient. The focused label sits in a pill; resting labels are collision-aware and a step quieter.
- **List and detail:** Linear/Raycast-style rows (type tile, title, two-line body, meta, relative date with the absolute date on hover; "—" when unknown) and a docked detail pane with a details grid, related memories with similarity meters, a history timeline and one action bar.
