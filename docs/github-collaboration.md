# PR and issue collaboration inside ytimesy

The workspace inspector's **Pull request** and **Issues** tabs use the selected repository. Repository tables use slim state filters, classic GitHub state icons, and Radix scroll rails. Open a row to work on it without opening GitHub; use the back control to return to the table. Issues' linked PR buttons open the PR inspector in the app.

## Available actions

- PR conversation: write a comment; edit or delete your own conversation and inline comments; reply to code threads; resolve and unresolve threads.
- PR files: use the line-number buttons (including by keyboard) to post a single comment or gather comments into a review. **Suggest change** inserts GitHub's suggestion syntax for a new-side line. Submit a comment review, approval, or change request. Authors cannot approve or request changes on their own PRs. A change request needs a summary. If the head changes while a review has pending comments, submission stops until the user discards those comments and reviews the new diff.
- PR management: edit title and description, request or remove reviewers, change assignees and labels, mark a draft ready, close/reopen, and explicitly confirm a merge of the reviewed head. GitHub remains authoritative for branch protection and supported merge methods.
- GitHub Actions checks: open the complete job log, rerun one finished job, or rerun the failed jobs of each failed workflow. Other CI providers' checks still show their status and an optional provider link; they have no GitHub Actions rerun API.
- Issues: filter, read, create, edit title/description, label, assign, comment, edit/delete your own comments, close as completed/not planned, and reopen. **Start chat** opens a new normal ytimesy thread whose first message includes the issue and asks for a PR closing it. **Review with ytimesy** likewise starts a new PR review thread instead of continuing the currently open chat. These use the normal model selection, admission, and workspace preparation paths.

## GitHub permissions

These actions use the signed-in user's GitHub App user token, not the installation bot identity. Both the user and the App must be allowed to access the repository. Mutations recheck repository authorization rather than using the short-lived read cache; API mutations also require the app origin and validated JSON input. Review-thread node IDs and comment IDs are checked against the selected item before changing them.

The App requires **Pull requests: write**, **Issues: write**, and **Actions: write** (which includes the log read permission), in addition to its existing contents/metadata/checks permissions. `scripts/setup-github-app.mjs` requests these for new registrations. Changing the manifest does **not** update an existing App: the App owner must enable Issues/Actions write in the App settings and installation owners must approve the new grant once. A missing write permission is shown beside the failed action rather than represented as success. No settings or installations are changed automatically by this PR.

## Verification

The credential-free browser fixture mounts the actual PR/issue components with explicitly simulated GitHub responses. It does not mount the authenticated application server, send GitHub requests, or start agents:

```sh
pnpm exec vite --config tests/fixtures/github-collaboration.vite.ts
```

Open `http://127.0.0.1:3101/tests/fixtures/github-collaboration.html`. With the shared desktop Chrome running on port 9222, run:

```sh
node --import tsx scripts/smoke/github-collaboration.ts
```

The smoke test covers the tables/search, comments/replies, resolution, an inline suggestion included in a submitted review, approval/change-request reviews, CI logs/reruns, title/reviewer/assignee/label changes, PR/issue close/reopen, linked-PR navigation, issue creation and 320px overflow. `tests/fixtures/github-collaboration.flow.json` records the UI surfaces for PR evidence. These are component-level simulations, **not** a live GitHub or model-run proof. Real provider verification requires configured OAuth secrets, a connected user token, and an installation with the permissions above.

No database migration, new dependency, deployment, harness change, or public npm publication is needed.
