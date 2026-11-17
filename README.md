# ytimesy

Cloud coding agents that keep working while you are away: give a task, get a pull request back, with a Diff, a Terminal and a Desktop you can watch and steer.

ytimesy runs its own harness, the model loop in `src/server/jobs/api-turn.ts`. You can power it with your ChatGPT or Claude subscription, or with your own API keys. A `ytimesy` CLI moves your existing local sessions (Claude Code, Codex, Cursor, Gemini CLI and others) into it.

> **Status:** early. Expect rough edges and breaking changes. Issues and pull requests are welcome.

## What is in this repository

| Path | What it is |
|---|---|
| `src/` | The web app (TanStack Start) and the server: harness loop, tools, adapters |
| `packages/ytimesy-cli` | The `ytimesy` CLI (`npx -y ytimesy@latest`) |
| `src/local-sessions` | Readers for local agent sessions, used by the CLI hand-off |
| `supabase/` | Database migrations |
| `infra/`, `wrangler.*.jsonc` | Deployment config (Cloudflare Workers) |
| `benchmarks/`, `evals/` | Benchmark and evaluation harnesses |
| `docs/` | Design notes and operating docs |
| `PLAN.md` | Product scope, stack and module boundaries |

## Quick start

Requires Node.js 22.13 or newer and [pnpm](https://pnpm.io) 10 (`corepack enable`). Works on macOS, Linux and Windows.

```sh
git clone <this repository> ytimesy && cd ytimesy
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env     # then fill in the values you need
pnpm dev                 # http://localhost:3000
```

The UI renders without secrets. Sign-in, GitHub, projects and cloud machines need runtime configuration (see `.env.example`): an auth secret, a Postgres `DATABASE_URL`, a Freestyle API key and GitHub App credentials.

### Common commands

```sh
pnpm test         # unit and integration tests (vitest)
pnpm lint         # biome
pnpm typecheck
pnpm build
```

### Use the CLI

```sh
npx -y ytimesy@latest --help
```

See [packages/ytimesy-cli/README.md](packages/ytimesy-cli/README.md).

## Documentation

Start with [PLAN.md](PLAN.md), then [docs/](docs/). Deployment and operations notes describe the hosted product; self-hosting guides are still being written.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE)
