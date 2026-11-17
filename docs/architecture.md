# Architecture

ytimesy is where software gets built with AI engineers. A **lead** agent plans and splits the work, **builder** agents write code in parallel, each on its own cloud machine, and **verifier** agents check the result in a real browser, with screenshots and video as proof.

This page is the map. The decisions behind it live in [PLAN.md](../PLAN.md), [Cloudflare execution model](edge-architecture-migration.md#cloudflare-execution-model-decision-2026-10-12) and [Where Claude Code runs](claude-code-placement.md).

## The system

```mermaid
flowchart LR
  subgraph Client
    UI["Web app<br/>TanStack Start + React"]
    CLI["ytimesy CLI<br/>moves local sessions"]
  end

  subgraph Edge["Cloudflare"]
    Web["Web Worker<br/>routes, auth, server functions"]
    Exec["Edge executor Worker"]
    DO_C["ModelConversation DO<br/>one per chat: runs the turns"]
    DO_J["BackgroundJobRunner DO<br/>short idempotent jobs"]
    DO_E["ProjectEnvironment DO<br/>builds a project's snapshot"]
    Cron(["Cron, every minute"])
    R2[("R2<br/>private checkpoints")]
  end

  PG[("Postgres (Supabase)<br/>durable records, admission")]
  VM["Freestyle VMs<br/>one per agent, copied from the project snapshot"]
  GH["GitHub App<br/>repos, branches, pull requests"]
  Models["Model sources<br/>ChatGPT, Claude, Grok subscriptions or your API keys"]

  UI --> Web
  CLI --> Web
  Web --> PG
  Web --> Exec
  Cron --> Exec
  Exec --> DO_C
  Exec --> DO_J
  Exec --> DO_E
  DO_C --> Models
  DO_C --> VM
  DO_C --> PG
  DO_C --> R2
  DO_E --> VM
  VM --> GH
```

| Piece | What it does |
|---|---|
| **Web app** (`src/routes`, `src/features`) | Server-rendered UI: chat, Diff, Terminal, Desktop, Memory, settings. Routes stay thin. |
| **Web Worker** (`wrangler.web.jsonc`) | Authentication, GitHub and project server functions, admission of new turns. |
| **ModelConversation** (Durable Object) | Owns one chat. Runs the turn **one model step per alarm** with SQLite step receipts, streams progress to the browser, and resumes after a deploy or eviction instead of failing. |
| **BackgroundJobRunner** (Durable Object) | Short on-demand jobs: turn admission, peer messages, checkpoints, environment admission. Idempotent by job ID. |
| **ProjectEnvironment** (Durable Object) | Clones, installs and verifies a project, then snapshots it. Long commands run detached on the VM. |
| **Cron** | Every minute: reconcile, supervise, deliver, checkpoint, PR repair and similar housekeeping. |
| **Postgres** | Durable records and cross-conversation admission. The source of truth. |
| **Freestyle VMs** | Each agent gets its own machine with a working tree, terminal and desktop, copied from the project's prepared snapshot. |
| **GitHub App** | Selected-repository access; each completed turn is committed and pushed to its own task branch, and a draft PR is opened. |
| **Model sources** | Your ChatGPT (Codex), Claude or Grok subscription, or your own API keys. API keys are encrypted at rest. |

## One task, end to end

```mermaid
sequenceDiagram
  actor You
  participant Lead as Lead agent (read-only)
  participant B1 as build-1 (own VM)
  participant B2 as build-2 (own VM)
  participant V as verify-1 (browser)
  participant GH as GitHub

  You->>Lead: "Add a dark mode toggle to settings"
  Lead->>Lead: explore the repo, plan, write todos
  par in parallel
    Lead->>B1: brief: theme tokens and the toggle
    Lead->>B2: brief: settings page
  end
  B1-->>Lead: patch + tests passed
  B2-->>Lead: patch + tests passed
  Lead->>Lead: review each patch, integrate
  Lead->>V: check it in a real browser
  V-->>Lead: screenshots + recording
  Lead->>GH: push task branch, open draft PR with evidence
  GH-->>You: pull request ready to merge
```

A few rules the system holds to:

- **The lead never edits.** New chats start as read-only leads; a code change needs a fresh read-write builder.
- **Every writer has its own machine**, working tree, ports and preview, so parallel agents cannot collide.
- **Work survives the browser.** Close the tab, come back later; the chat keeps running and reconnects.
- **Bookkeeping never blocks you.** Usage accounting, analytics and logging may fail without failing the action.
- **Nothing silently falls back to paid inference.** You choose the model source.

## Code map

| Path | Responsibility |
|---|---|
| `src/routes` | Navigation, request validation, auth boundary. No provisioning logic. |
| `src/features/*` | UI by feature: projects, sessions, workspace, landing, onboarding. |
| `src/domain` | Models, state transitions and pure policies. No React, HTTP or provider SDKs. |
| `src/server/services` | Workflows: project setup, session lifecycle, publication, recovery. |
| `src/server/adapters` | Freestyle, GitHub, database, model providers, jobs. Provider details stay here. |
| `src/server/jobs` | Durable job handlers, including the model loop (`api-turn.ts`). |
| `src/server/auth` | Identity, tenant membership, repository permissions. |
| `src/local-sessions` | Readers for local agent sessions, used by the CLI hand-off. |
| `packages/ytimesy-cli` | The published `ytimesy` CLI. |
| `supabase/migrations` | Database schema. |

Dependency direction: UI → authenticated server entry → service → capability → adapter.
