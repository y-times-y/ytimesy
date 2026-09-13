# ytimesy

Before implementation or architectural changes, read [PLAN.md](PLAN.md) for the product scope, accepted stack, module boundaries, and acceptance criteria.

Before writing or reviewing code, apply [.agents/skills/self-documenting-code/SKILL.md](.agents/skills/self-documenting-code/SKILL.md). Keep routes thin, models focused, and provider details behind explicit adapters.

Use agent-browser for browser research and UI verification, as requested by the user. Keep reference screenshots out of commits. Report live verification separately from mock tests and build checks.

The first release must include Diff, Terminal, and Preview. Freestyle, TanStack Start, and Effect are selected. Consult PLAN.md for unresolved provider choices rather than silently treating proposals as decisions.

Before database schema changes, Supabase setup, or migration deployment, read [Supabase and GitHub workflow](PLAN.md#supabase-and-github-workflow). It records the selected provider, migration ownership, integration settings, and unverified setup state.
