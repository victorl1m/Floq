# Home redesign research (2026-11)

Goal: replace the busy matrix-rain Home with a calm, composer-first start screen. We took ideas only; no layouts, assets or brand marks were copied.

## References

1. **Linear, "Behind the latest design refresh" (Mar 2026)** — https://linear.app/now/behind-the-latest-design-refresh
   Take: the work area takes precedence and orientation chrome is dimmed a few steps; fewer, softer separators; fewer and smaller icons. → Home drops the header bar and divider lines; sections are labelled by quiet 13 px captions.
2. **Linear changelog, UI refresh** — https://linear.app/changelog/2026-03-12-ui-refresh
   Take: "calmer, more consistent" means neutral greys with one accent used only for the primary action. → Orange stays on Start agent only.
3. **Claude composer teardown** — https://ai-design-patterns.pages.dev/teardowns/claude/composer
   Take: one card holds everything; attach on the left rail, model/effort pickers on the right rail, send at the far right; starter pills under a calm empty card; model visible before typing. → Composer footer: attach + project left, provider + model + Start right.
4. **"How to design an AI chat composer"** — https://aiuxplayground.com/guides/how-to-design-ai-chat-composer
   Take: never disable send without saying what is missing; show attachments as chips before send; starters must not promise what the product cannot do. → Disabled Start keeps its tooltip + sr reason, and a visible inline reason sits in the hint row.
5. **Prompt-input pattern gallery (SaaSFrame)** — https://www.saasframe.io/patterns/prompt-input
   Take: the composer is the hero, centred, with one short heading above; secondary content starts well below the fold line of the composer.
6. **v0 / Bolt / Lovable comparison (Addy Osmani)** — https://addyo.substack.com/p/ai-driven-prototyping-v0-bolt-and
   Take: all three lead with a single prompt box; Lovable/v0 put "continue where you left off" content right under it. → Recent agents and projects as cards under the starters.
7. **Coding-agent UIs converging (Codex app, Cursor 3, Claude desktop)** — https://dev.to/javieraguilarai/the-interface-moved-up-2o8b
   Take: home shows suggested prompts plus the live agent sessions grouped by project. → "Recent agents" cards show avatar, state, project and age, and jump straight to the agent on the canvas.
8. **Raycast visual language (third-party extraction)** — https://blakecrosley.com/guides/design/raycast
   Take: dark-first, precise, keycap-style shortcut chips, glow used sparingly as a single light source. → One soft, static glow behind the composer; keyboard hint chips inside the hint row.

## Chosen direction

- **Composer is the hero:** a single raised card, 720 px max, with attachments, the prompt, and one toolbar row (attach, project · provider, model, Start). Nothing else on the page competes with it.
- **Short greeting, no page chrome:** "Good evening, Victor" as the heading, one muted line beneath; the old header bar and dividers are gone.
- **Quiet backdrop:** a static dot grid that matches the canvas dots (`--canvas-dot`, 22 px), masked to fade out from the top, plus one soft static glow behind the composer. No motion; glow removed for Solid, reduced transparency and forced colours.
- **Continue where you left off:** recent agents (with the agent avatar and a state label) and projects as compact cards in a responsive grid; one-click to the canvas.
- **Empty states that lead:** no project → a single card that explains why a project is needed and offers Add project; no agents → a line pointing back at the composer.
