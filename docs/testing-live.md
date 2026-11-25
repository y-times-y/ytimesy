# Verify a change live (the test account)

Agents verify live themselves. **Do not report "not verified".** Sign in as the
synthetic test account, which exists for exactly this.

## In 5 lines

```bash
export YTIMESY_TEST_SESSION_TOKEN=...   # already in your environment (account secret); never paste it
node --import tsx scripts/test-session.ts mint                      # session cookie, 15 min, test user only
node --import tsx scripts/test-session.ts shot --path / --out /tmp/a.png \
  --step "fill:Message=say hi" --step "press:Enter" --step "wait:30000"   # headless Chrome, signed in
node --import tsx scripts/test-session.ts reset                     # delete the test project's data
node --import tsx scripts/test-session.ts seed-usage                # made-up daily token usage for the Usage page's heatmap (cleared by reset)
```

`shot` prints JSON with the page URL, title and visible text; view the PNG with
your read tool. Needs Chrome (`CHROME_PATH`, or the installed `chrome` channel).
Pass `--base http://127.0.0.1:PORT` to use a local server.

## What it is

- One user, `ytimesy-test@example.test` (id `ytimesy-test-account`), with
  `auth_user.is_test_account = true`. A unique index allows exactly one.
- It lives in production, because live verification needs production and a
  second environment would not prove the deployed build. The risk is bounded:
  the account owns only its own rows, the capability reaches no other user, and
  its sessions last 15 minutes.
- Excluded: analytics (no PostHog events), email (the `.test` domain is never
  mailed), public stats and billing (it has no subscription and its id is
  recognised by `isTestAccountId`).
- Mint is `POST /api/internal/test-session` with `Authorization: Bearer <token>`.
  The body has only `action` (`mint`, `reset` or `seed-usage`) and `caller`. There is no
  user id or email parameter anywhere. The server refuses unless the target row
  is flagged, limits mints to 30 an hour, and records each use in
  `test_session_event` and as a `test_session.minted` log line with the caller.
  A wrong or missing token gets 404.

## Model access

A real model turn needs a model connection on the test account. The owner adds
one cheap API key once (below); until then a turn cannot run.

## Threat model and revocation

- The token is derived from the signing root and a version
  (`deriveTestSessionToken`); the Worker keeps only its hash
  (`YTIMESY_TEST_SESSION_TOKEN_SHA256`). Agents get the token as the account
  secret `YTIMESY_TEST_SESSION_TOKEN`.
- A leaked token can mint 15-minute sessions for the test user and reset the
  test user's projects. It cannot reach another user, read the database, or act
  as an admin. The signing root is never exposed.
- Revoke: set `YTIMESY_TEST_SESSION_TOKEN_VERSION` to a new value in the
  production env, deploy, and replace the account secret with the new token.
  Disable entirely by removing the hash secret (the endpoint then answers 404).

## Forbidden

- Listing or querying real users or their data (`auth_user`, projects, chats).
- Minting or forging sessions for real users, or any hand-rolled session.
- Creating GitHub repositories.
- Using production secrets or the database URL to "test".

If the script cannot do what you need, say what is missing; do not work around it.
