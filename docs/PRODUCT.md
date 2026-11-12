# Floq

## Product and audience

Repository-derived context: Floq is a desktop workspace for developers directing Claude Code and Codex agents on a self-hosted runtime. The primary job is to choose a project, describe work, and follow agents through terminals, task boards, and a project canvas. Audience details beyond this are not yet confirmed.

## Platform and stack

Web interface in a Tauri desktop wrapper. React 19, TypeScript, Vite, Tailwind CSS, Radix primitives, Tabler icons. Keep the web interface usable at narrow widths.

## Workflows

Runtime sign-in, first-administrator setup, invitation registration, project import, agent creation, terminal sessions, task boards, skills and MCP management, secrets, and account/runtime/organization settings. Preserve authorization, runtime API contracts, credentials handling, session persistence, and terminal scrollback.

## Current request

The user requested a full interface redesign including login, all screens, and all dialogs, while preserving functional behavior and existing Floq and provider brand marks. The current material direction uses native Mica/Acrylic/vibrancy with Floq-owned CSS surfaces.

## Accessibility

Keep keyboard access, named controls, form validation, focus management, reduced-motion support, and opaque material fallbacks. UI copy currently uses English. Other audience and locale policies remain unconfirmed.
