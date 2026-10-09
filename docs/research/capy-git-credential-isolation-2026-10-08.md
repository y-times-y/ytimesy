# Capy GitHub credential isolation

Verified against current first-party documentation on 2026-10-08 using agent-browser. This is documentation evidence, not an audit of Capy's implementation or a live authenticated test.

## Documented architecture

- **GitHub credentials stay outside execution VMs.** Capy says reusable user tokens, installation tokens, and app keys are absent from machines both on disk and in memory. A VM holds a short-lived signed Capy grant that authenticates only to its git proxy, not directly to GitHub. The control plane delivers grants; copied grants retain their original expiry, and sleeping machines' grants expire on disk. [Security](https://docs.capy.ai/admin/security)
- **The proxy brokers repository operations.** It validates the grant, attaches a GitHub installation token on Capy's side for each operation, and streams the response. Capy describes ordinary `git` and `gh` calls as going through this proxy; grants last approximately two hours and refresh automatically. [Security](https://docs.capy.ai/admin/security), [GitHub authentication](https://docs.capy.ai/integrations/github#how-capy-authenticates)
- **Credential isolation does not mean ref restrictions.** Capy explicitly says the proxy neither rewrites commands nor gates refs. Branch restrictions come from GitHub branch protection. The product's normal publication flow creates a `capy/` branch rather than pushing agent work to the base branch; that workflow promise is distinct from a proxy-enforced prohibition on arbitrary push targets. [Security](https://docs.capy.ai/admin/security), [Pull requests](https://docs.capy.ai/pull-requests)

## Repository access and permissions

The GitHub App installation selects all repositories or a chosen subset. Project threads automatically clone attached repositories when their machines start, using shallow clones at each repository's base branch through the proxy. Private repositories, submodules, and private dependencies covered by the installation are supported. [GitHub](https://docs.capy.ai/integrations/github), [Machine boot](https://docs.capy.ai/machines#how-a-machine-boots)

The documented permission purposes are Contents for clone/fetch/push, Pull requests for PR creation and feedback/review comments, Checks and commit statuses for CI results, and Metadata for listing repositories. Repository reach follows the installation: read-only installations cannot write, and repositories outside its scope return GitHub's 404. The docs list purposes rather than a complete current GitHub App permission manifest. [GitHub permissions](https://docs.capy.ai/integrations/github#permissions)

Push authentication always uses the app. Commit author and PR author are independently resolved from the connected personal GitHub account, with Capy's identity as fallback. Security documentation says this attribution also applies to `gh pr create`, and disconnecting the personal account stops its use immediately and revokes its token at GitHub. Tools expecting a raw `GH_TOKEN` fail because one is absent; `gh api` is the supported path. [GitHub authentication](https://docs.capy.ai/integrations/github#how-capy-authenticates), [Security](https://docs.capy.ai/admin/security)

Capy documents a rule requiring an explicit request for the specific merge in the current conversation before PR merge or auto-merge, including CLI and API paths. This is a documented agent rule; the same page does not establish an independently enforced proxy authorization check for merges. [Security](https://docs.capy.ai/admin/security)

## Unknowns and limits

- Grant format, exact claims and repository/method scope, signing algorithm, replay protection, and compromise handling beyond expiry are not specified in these pages.
- The implementation of `git`/`gh` routing, proxy endpoints, server-side token storage and rotation, and the full GitHub App permission manifest were not inspected.
- The docs distinguish app-authenticated pushes from personally attributed PRs but do not fully describe how server-side credentials implement every GitHub API attribution case.
- A stolen grant can still confer whatever proxy operations it authorizes during its remaining lifetime. Its unusability directly against GitHub does not establish zero authority through Capy's proxy; exact limits are undocumented here.
- No authenticated VM inspection, malicious-repository experiment, push/PR test, token capture, or source-code audit was performed.

## Relevance to ytimesy

Capy is a documented example of separating GitHub credential custody from an untrusted execution VM while retaining standard CLI workflows. Reproducing its documented architecture would require a proxy and scoped expiring VM grants. GitHub permissions, branch protection, and any desired operation restrictions remain separate decisions; credential isolation alone does not supply them.
