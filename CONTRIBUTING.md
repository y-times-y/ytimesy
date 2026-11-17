# Contributing

Thanks for helping. This project is young, so small, focused changes are easiest to review.

## Setup

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm test && pnpm lint && pnpm typecheck
```

Node.js 22.13+ and pnpm 10. Changes must work on macOS, Linux and Windows: no shell-only scripts without an equivalent, no hard-coded path separators.

## Pull requests

1. Open an issue first for anything larger than a small fix.
2. Read [PLAN.md](PLAN.md) for scope and module boundaries. Keep routes thin and keep provider details behind adapters.
3. Add or update tests, and run `pnpm test`, `pnpm lint` and `pnpm typecheck`.
4. Keep commits focused. Describe what changed and why.
5. Never commit secrets, `.env` files or real customer data. Use placeholders such as `example.com`.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
