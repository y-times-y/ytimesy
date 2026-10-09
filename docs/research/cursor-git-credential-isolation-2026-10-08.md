# Cursor Cloud Agent GitHub credential isolation

Verified current first-party documentation on 2026-10-08 using agent-browser. Documentation research only; no authenticated VM inspection or implementation audit.

## Finding

Cursor documents GitHub App authorization, encrypted backend credential storage, and a hosted git egress proxy. The inspected pages do **not** establish that reusable GitHub credentials are absent from execution VMs, or that the proxy attaches GitHub credentials outside the VM. An egress proxy is affirmative evidence of network routing, not evidence of credential isolation.

## What the official docs support

- **Authorization:** Admins install the GitHub App for selected repositories, and each triggering user connects their own Git account. Cloud Agent access is bounded by the triggering user's existing repository access. Agents clone the repository, work on a separate branch, and push for handoff. [Security overview](https://cursor.com/docs/cloud-agent/security), [Cloud Agents](https://cursor.com/docs/cloud-agent)
- **Credential storage:** The security overview places configured secrets, OAuth tokens, and API credentials in encrypted backend credential stores. This describes custody/storage; it does not state whether GitHub tokens are subsequently injected or exposed to the VM during execution. [Security overview](https://cursor.com/docs/cloud-agent/security#what-data-is-stored-where-and-for-how-long)
- **Git egress proxy:** Cursor supports routing git traffic through a hosted proxy with a narrower set of egress IPs across GitHub, GitLab, Azure DevOps, and Bitbucket. The integration guide describes enabling installed-GitHub-App IP allowlists or coordinating with Cursor to enable the proxy for teams that directly add its IPs. The docs also describe clone/push from Cloud Agent IPs when the proxy is not used. They do not document server-side credential attachment, signed VM grants, or token-free VMs. [Secrets & Network](https://cursor.com/docs/cloud-agent/security-network#egress-ip-ranges), [GitHub IP allowlists](https://cursor.com/docs/integrations/github#ip-allow-list-configuration)
- **Permissions:** The GitHub App supports repository cloning and working branches, PR creation/review comments, issues, checks/statuses, and workflow monitoring/re-runs. The guide also lists permissions for reading branch protection, user roles, and organization properties. It instructs granting PR write access and checking branch protection when PR creation is denied. [GitHub permissions](https://cursor.com/docs/integrations/github#permissions)
- **General customer secrets:** Runtime Secrets are loaded as environment variables and redacted from tool results, transcripts, commits, and commit messages. Their values remain accessible through the environment's Terminal. Build Secrets are available only during Docker builds. This is a documented distinction between redaction and execution-environment accessibility; these pages do not say Cursor's GitHub integration token uses either mechanism. [Secrets & Network](https://cursor.com/docs/cloud-agent/security-network#secret-protection)
- **Execution boundary:** Cloud Agents use dedicated Firecracker microVMs in a separate AWS account. Isolation of one agent from others does not establish isolation of that agent from credentials used within its own VM. [Security overview](https://cursor.com/docs/cloud-agent/security#isolation-and-infrastructure)

## Undocumented in the inspected sources

GitHub runtime token placement; credential helper/wrapper implementation; server-side token injection; reusable credential exclusion from VM memory/disk; grant lifetime/scope/revocation; proxy operation or ref restrictions; whether every GitHub API/`gh` request passes through a broker. None should be asserted present or absent from these pages.

## Comparison boundary

Capy explicitly documents a short-lived proxy grant on the VM and GitHub credentials attached server-side. Cursor's inspected docs establish an egress proxy and backend credential storage, but do not establish that same credential-isolation design. This is a difference in available documentation evidence, not proof that Cursor lacks the design. See [Capy's security documentation](https://docs.capy.ai/admin/security).

Checked pages: [Cloud Agents](https://cursor.com/docs/cloud-agent), [Security overview](https://cursor.com/docs/cloud-agent/security), [Secrets & Network](https://cursor.com/docs/cloud-agent/security-network), [GitHub integration](https://cursor.com/docs/integrations/github), and [Cursor security](https://cursor.com/security).
