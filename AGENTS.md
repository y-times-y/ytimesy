# ytimesy

Before implementation or architectural changes, read [PLAN.md](PLAN.md) for the product scope, accepted stack, module boundaries, and acceptance criteria.

Before writing or reviewing code, apply [.agents/skills/self-documenting-code/SKILL.md](.agents/skills/self-documenting-code/SKILL.md). Keep routes thin, models focused, and provider details behind explicit adapters.

Reuse before building: before implementing general-purpose logic, inspect existing project utilities, platform APIs, and maintained libraries that solve it. Verify compatibility, security, maintenance, licensing, and the actual user workflow before choosing. Prefer the smallest suitable existing solution; keep custom code focused on product-specific behavior. If custom logic is necessary, explain the concrete gap first. When replacing custom logic with a library, remove the superseded implementation and test the integration, including edge cases and live behavior.

Use agent-browser for browser research and UI verification, as requested by the user. Keep reference screenshots out of commits. Report live verification separately from mock tests and build checks.

The first release must include Diff, Terminal, and Desktop. ytimesy owns the harness; Codex and Claude Code are its offered runtime adapters. OpenCode is legacy-only and must not be offered for new sessions or delegated tasks. Freestyle, TanStack Start, and Effect are selected. Consult PLAN.md for unresolved provider choices rather than silently treating proposals as decisions.

Before database schema changes, Supabase setup, or migration deployment, read [Supabase and GitHub workflow](PLAN.md#supabase-and-github-workflow). It records the selected provider, migration ownership, integration settings, and unverified setup state.

Cloudflare execution: there are no Workflows. Before adding one, moving work into a Durable Object alarm or cron, or changing how chat turns or environment builds run or resume, read [Cloudflare execution model](docs/edge-architecture-migration.md#cloudflare-execution-model-decision-2026-10-12). Alarms and cron stop after 15 minutes, and Durable Objects restart on every deploy.
