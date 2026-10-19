# ytimesy Privacy Policy (draft)

> DRAFT, NOT LEGAL ADVICE. Written from the product's code (branch `launch`,
> commit 6af3c58) and peer policies (Cursor, [competitor], [competitor]). Counsel must
> review before it takes effect. Items marked `[OWNER/COUNSEL: ...]` need a
> decision. Anything here that the product does not yet do is listed in
> [required-product-changes.md](./required-product-changes.md) and must ship
> before this policy is published.

Last updated: [DATE].

This policy explains what [OWNER/COUNSEL: legal entity name and address]
("ytimesy", "we") collects when you use ytimesy, why, who else receives it, how
long we keep it, and your choices. It is part of our
[Terms of Service](./terms.md).

## The short version

- We collect what we need to run coding agents on your repositories: your
  account, the repositories you connect, your chats, the files and commands in
  your workspaces, and encrypted credentials you give us.
- Your prompts and the code an agent reads go to **the model provider you
  chose**, under your own key or subscription and your own agreement with that
  provider.
- **We do not train AI models on your data, and we do not let anyone else do
  so, unless you turn on "Help improve ytimesy" in settings.** It is off by
  default and you can turn it off at any time. See
  [Training Data Opt-In](./training-opt-in.md).
- We do not sell your personal information or use it for advertising.
- You can delete chats, projects, your memory, and your whole account yourself.

## 1. What we collect

**Account.** Name, email address, profile image, and the identity you sign in
with (email and password, GitHub, or Google). Passwords are stored only as
hashes. GitHub sign-in asks only for your profile and email (`user:email`).

**GitHub connection.** If you install the ytimesy GitHub App, we receive the
list of accounts and repositories you selected and a token to act on them. If
you connect your GitHub account, we store its access token encrypted. See
"GitHub" below.

**Your content.** Prompts and messages, file attachments, the agent's replies
and tool output (commands run, their output, file contents read and written,
diffs), pull requests the agent opens, project settings, and pull request
evidence (screenshots, short screen recordings and command output captured
from a pull request's code).

**Workspaces.** Each chat runs in a cloud virtual machine with a copy of your
repositories, installed dependencies, and anything the agent or you create
there. Idle workspaces are saved as snapshots so you can resume.

**Credentials you give us.** Model API keys, OpenAI-compatible endpoint
settings, your ChatGPT/Codex sign-in tokens (from the device-code sign-in),
project secrets and environment variables, and MCP server settings and
sign-ins. These are **encrypted at rest** with application-level encryption and
decrypted only to run your work.

**Memory.** If memory is on, ytimesy keeps notes from your chats (preferences,
project facts, lessons) in a private memory repository for your account and
creates numeric embeddings of those notes so agents can recall relevant ones.
You can view, clear or turn off memory in settings.
[OWNER: memory is ON by default today (`user_memory.mode` defaults to
`full`). Decide whether to keep that default; this policy discloses it either
way.]

**Usage and billing records.** Which models and runtimes you used, token
counts, workspace time and size, and usage against our caps. We do not store
model prices you pay your provider.

**Product analytics.** Through PostHog we record a small, fixed set of
product events (for example "account created", "turn started/finished",
"pull request created", which inspector panel was opened), with no prompt,
code, file names or repository names in them. IP-based location lookup is
disabled. We also record **session replays** of how the web app is used, with
all text masked and code, terminals, chat content, inputs, images and the
desktop view blocked before anything leaves your browser; network bodies and
headers and console logs are not recorded. We honour the browser
"Do Not Track" setting for analytics. [OWNER/COUNSEL: whether EU/UK visitors
need a consent prompt before replay; see required product changes.]

**Logs.** Our hosting providers keep operational logs (requests, errors,
timings) that can include IP addresses and identifiers, for security and
debugging.

**Email.** We send account emails (verification, password reset) from
noreply@ytimesy.com. Mail you send to our addresses is received by our email
provider.

We do not knowingly collect information from children (see Terms, section 2).

## 2. How we use it

- To provide the service: sign you in, connect repositories, run agents and
  workspaces, save and restore chats, push branches and open pull requests,
  show your history and evidence.
- To call the model you chose with your prompts and the context the agent
  needs.
- To enforce usage caps and the Terms, prevent abuse, and keep the service
  secure.
- To support you when you contact us.
- To understand and improve the product using the analytics described above.
- **Only if you opt in:** to improve ytimesy's agents and train or evaluate
  models, as described in [Training Data Opt-In](./training-opt-in.md).

**People at ytimesy do not read your code, chats or workspaces** except (a)
when you ask us to (for example in a support request), (b) to investigate
abuse, security incidents or a legal request, or (c) when you have opted in to
training use, and then only as that document describes. Access is limited to
personnel who need it. [OWNER: confirm and enforce this; there is no audited
admin read path today.]

For EU/UK users, our legal bases are: performance of our contract with you
(running the service), legitimate interests (security, abuse prevention,
product analytics), consent (training use, and analytics where required), and
legal obligation.

## 3. Model providers

Agents run on the model you pick. When an agent runs, ytimesy sends your
prompt, conversation history, and the code, files and tool output the agent
needs to that provider:

- **Your API key or endpoint** (OpenAI, Anthropic, Google Gemini, OpenRouter,
  or an OpenAI-compatible endpoint you set): the provider processes the request
  under **your** agreement with it, including its retention and training
  policies. With OpenRouter, the request also goes to the model host OpenRouter
  routes it to.
- **Your ChatGPT / Codex subscription**: requests are sent to OpenAI on your
  account, under your ChatGPT agreement and settings.

We do not control how these providers handle data. Check your provider's
settings (for example API data controls or ChatGPT's "Improve the model for
everyone") if you want them not to retain or train on your data. We do not
have zero-data-retention agreements with model providers because the
agreement is yours, not ours.

ytimesy itself uses **Cloudflare Workers AI** to create embeddings of your
memory notes. Workers AI does not use that data to train models.
[COUNSEL: confirm against Cloudflare's current Workers AI terms.]

## 4. GitHub

The ytimesy GitHub App works only on the accounts and repositories you choose
when you install it. It asks for: repository contents (read and write), pull
requests (read and write) and metadata (read); and checks (read) where the
agent repairs failing pull requests. [OWNER: the App manifest in
`scripts/setup-github-app.mjs` lacks `checks: read` while `pr-repair-evidence`
requests it; align the production App and this list.] We use this to clone
your code into your workspace, push branches, open and update pull requests,
and read check results. The agent does not merge pull requests. You can change
the App's repositories or uninstall it at any time in GitHub settings.

Pull request descriptions written by the agent may link to evidence pages on
ytimesy; those pages need a ytimesy sign-in and are visible only to you.
[OWNER: confirm; reviewers on the repo cannot see them today.]

## 5. Who else receives data (subprocessors)

We use these providers to run ytimesy. Each processes data only to provide its
service to us.

| Provider | What it does for us | Data | Location |
|---|---|---|---|
| Cloudflare, Inc. | Web app and API hosting (Workers, Durable Objects), private object storage (R2: encrypted chat checkpoints, encrypted attachments, pull request evidence), memory repositories (Artifacts), memory embeddings (Workers AI), outbound email, network egress, logs | All categories above | Global edge; storage [OWNER: confirm R2 location hint] |
| Supabase, Inc. | Main database (Postgres): account, projects, chats, usage, encrypted credentials | Account, content, credentials (encrypted), usage | United States (Ohio, AWS us-east-2) |
| Freestyle | Workspace virtual machines and their snapshots | Repository copies, workspace files, command output, secrets you inject | [OWNER: confirm region] |
| PostHog, Inc. | Product analytics and masked session replay | Account id, product events, masked replay | United States |
| GitHub, Inc. | Sign-in and repository access | Account, repository content | United States |
| Google LLC | Sign-in with Google (if you use it) | Account | United States |
| The model provider you choose (OpenAI, Anthropic, Google, OpenRouter and its hosts, or your endpoint) | Runs the model | Prompts, code and tool output sent for each turn | Provider's locations |

Model providers you choose act under your agreement with them; we list them
for transparency. We will update this list before adding a subprocessor
[OWNER: and notify users by email/changelog N days ahead?].

We may also disclose data if required by law, to protect people or the
service, or as part of a merger or acquisition (with notice to you).

## 6. How long we keep it

| Data | Kept |
|---|---|
| Account, projects, chats, tool output, usage | Until you delete them or your account |
| Workspace VM | Stopped after about 1 hour idle |
| Saved workspace snapshot of an idle chat | Up to 90 days, then deleted; or sooner when you delete the chat, project or account |
| Chat checkpoints and attachments (encrypted, R2) | Until you delete the chat, project or account |
| Pull request evidence | 30 days, or until the pull request closes, whichever is first; or when you delete the project or account |
| Memory repository and embeddings | Until you clear memory or delete your account |
| Credentials, keys, secrets | Until you remove them or delete your account |
| Pending sign-in records (email codes, device codes) | Until used or expired |
| Analytics events and replays | Per PostHog retention [OWNER: set and state, e.g. 12 months events, 30 days replay] |
| Hosting logs | Per provider default [OWNER: state, e.g. up to 30 days] |
| Data you opted in for training | See [Training Data Opt-In](./training-opt-in.md) |
| Backups held by our database provider | Rolled off within [OWNER: confirm Supabase PITR/backup window] |

## 7. Deleting your data

- **Chats**: deleting a chat removes its messages, saved checkpoints,
  attachments, workspace and saved workspace snapshots, and those of its
  subagent chats.
- **Projects**: deleting a project removes its chats (with the above),
  workspaces, environment snapshots and pull request evidence. Your GitHub
  repositories are not touched.
- **Memory**: "Clear memory" deletes your memory repository.
- **Account**: Settings, Delete account. This immediately deletes your
  account, chats, attachments, checkpoints, pull request evidence, workspaces
  and snapshots, memory, credentials and usage history, and signs you out
  everywhere. Records we must keep (aggregate spend ledgers without your
  identity, and anything required by law) are kept.
- Deleting your ytimesy account **does not** uninstall the GitHub App, revoke
  your ChatGPT sign-in at OpenAI, or delete data your model provider holds.
  Uninstall or revoke those directly. [See required changes.]
- Copies in provider backups and logs age out on their normal schedule.

## 8. Your rights

Depending on where you live (including the EU, UK and California) you may
have the right to access, correct, delete, or receive a copy of your data, to
object to or restrict some processing, and to withdraw consent. Most of this
you can do yourself in the app. For anything else, email
[OWNER: privacy@ytimesy.com]. We will respond within the time the law requires
and will not treat you differently for exercising a right. EU/UK users can
complain to their data protection authority.

We do not sell or "share" personal information for cross-context behavioural
advertising as those terms are defined in California law.

## 9. Security

Credentials, keys, secrets, chat checkpoints and attachments are encrypted at
the application level before storage, in addition to provider encryption at
rest. Database tables are not reachable from the browser directly. Each chat
runs in its own virtual machine. Traffic is encrypted in transit. No system is
perfectly secure; if a breach affects your data we will notify you as the law
requires. Report vulnerabilities to [OWNER: security@ytimesy.com].

## 10. International transfers

We are based in [OWNER/COUNSEL: country] and our providers process data in the
United States and elsewhere. Where the law requires, we rely on the providers'
Standard Contractual Clauses or the EU-US Data Privacy Framework.
[COUNSEL: confirm the mechanism per provider.]

## 11. Changes

We will post changes here and, for material ones, notify you by email or in the
app before they apply. **A policy change will never turn training use on for
you.**

## Contact

[OWNER: privacy@ytimesy.com, legal entity, postal address; EU/UK
representative if required.]
