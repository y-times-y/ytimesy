# ytimesy Privacy Policy (draft)

> DRAFT, NOT LEGAL ADVICE. Written from the product's code and the current
> Cursor and Capy policies (read on their websites, 2026-11-02). Counsel must
> review before it takes effect. Items marked `[OWNER/COUNSEL: ...]` need a
> decision. Anything here that the product does not yet do must ship before
> this policy is published.

Last updated: [DATE].

This policy explains what [OWNER/COUNSEL: legal entity name and address]
("ytimesy", "we") collects when you use ytimesy, why, who else receives it, how
long we keep it, and your choices. It is part of our
[Terms of Service](./terms.md). By creating an account or signing in, you
acknowledge this policy.

## The short version

- We collect what we need to run coding agents on your repositories: your
  account, the repositories you connect, your chats, the files and commands in
  your workspaces, and encrypted credentials you give us.
- Your prompts and the code an agent reads go to **the model provider you
  chose**, under your own key or subscription and your own agreement with that
  provider.
- **Training data.** The "Help improve ytimesy" setting is shown during
  onboarding and is **on by default**. When on, we use your prompts and
  messages, your code and repository context, and results to improve ytimesy.
  **We never use AI models' replies or model-generated code as training
  data.** Turn it off at any time in Settings, Privacy; then nothing is used.
  See [Training Data](./training-opt-in.md).
- We do not sell your personal information or use it for advertising.
- You can delete chats, projects, your memory, and your whole account yourself.
- ytimesy is for people 18 and older.

## 1. What we collect

**Account.** Name, email address, profile image, and the identity you sign in
with (email and password, GitHub, or Google). Passwords are stored only as
hashes. GitHub sign-in asks only for your profile and email (`user:email`).
We record which version of the Terms and this policy was in effect when you
signed up.

**GitHub connection.** If you install the ytimesy GitHub App, we receive the
list of accounts and repositories you selected and a token to act on them. If
you connect your GitHub account, we store its access token encrypted. See
section 5.

**Your content.** Prompts and messages, file attachments, the agent's replies
and tool output (commands run, their output, file contents read and written,
diffs), pull requests the agent opens, project settings, and pull request
evidence (screenshots, short screen recordings and command output captured
from a pull request's code).

**Workspaces.** Each chat runs in a cloud virtual machine with a copy of your
repositories, installed dependencies, and anything the agent or you create
there. Idle workspaces are saved as snapshots so you can resume.

**Credentials you give us.** Model API keys, OpenAI-compatible endpoint
settings, sign-in tokens for subscriptions you connect (for example ChatGPT/
Codex, a Claude Code setup token, or xAI), project secrets and environment
variables, and MCP server settings and sign-ins. These are **encrypted at
rest** with application-level encryption and decrypted only to run your work.

**Memory.** If memory is on, ytimesy keeps notes from your chats (preferences,
project facts, lessons) in a private memory repository for your account and
creates numeric embeddings of those notes so agents can recall relevant ones.
You can view, clear or turn off memory in settings.
[OWNER: memory is ON by default today. Decide whether to keep that default;
this policy discloses it either way.]

**Training settings.** Whether "Help improve ytimesy" is on, when it changed,
which policy version you saw, and which projects you excluded.

**Usage records.** Which models and runtimes you used, token counts, workspace
time and size, and usage against our 5-hour and weekly limits. We take no
payments, so we hold no payment details.

**Product analytics.** Through PostHog we record a small, fixed set of
product events (for example "account created", "turn started/finished",
"pull request created", which inspector panel was opened), with no prompt,
code, file names or repository names in them. IP-based location lookup is
disabled. **Only if you accept** the recording prompt, we also record
**session replays** of how the web app is used, with all text masked and code,
terminals, chat content, inputs, images and the desktop view blocked before
anything leaves your browser; network bodies and headers and console logs are
not recorded. Replay is off until you accept, and you can turn it off at any
time in Settings, Privacy (the choice is kept in your browser). We honour the
browser "Do Not Track" setting for analytics. [COUNSEL: confirm product events
without replay can rely on legitimate interest for EU/UK visitors.]

**Logs and bot checks.** Our hosting provider keeps operational logs
(requests, errors, timings) that can include IP addresses and identifiers, for
security and debugging. Email sign-up, sign-in and password reset use
Cloudflare Turnstile to block bots.

**Email.** We send account emails (verification, password reset) from
noreply@ytimesy.com. Mail you send to our addresses is received by our email
provider.

## 2. Children

ytimesy is not for anyone under 18 (see Terms, section 2). We do not knowingly
collect personal information from anyone under 18. If we learn or have reason
to believe that an account belongs to someone under 18, we close the account
and delete its data as described in section 8. If you believe a minor has an
account, contact [OWNER: privacy@ytimesy.com].

## 3. How we use it

- To provide the service: sign you in, connect repositories, run agents and
  workspaces, save and restore chats, push branches and open pull requests,
  show your history and evidence.
- To call the model you chose with your prompts and the context the agent
  needs.
- To enforce usage limits and the Terms, prevent abuse, and keep the service
  secure.
- To support you when you contact us.
- To understand and improve the product using the analytics described above.
- **If "Help improve ytimesy" is on**, to improve ytimesy's agents and to
  train or evaluate models, using only the data listed in section 4.

**People at ytimesy do not read your code, chats or workspaces** except (a)
when you ask us to (for example in a support request), (b) to investigate
abuse, security incidents or a legal request, or (c) when training use is on,
and then only as the [Training Data](./training-opt-in.md) policy describes.
Access is limited to personnel who need it. [OWNER: confirm and enforce this;
there is no audited admin read path today.]

For EU/UK users, our legal bases are: performance of our contract with you
(running the service), legitimate interests (security, abuse prevention,
product analytics), consent (training use, and analytics where required), and
legal obligation. [COUNSEL: an on-by-default setting may not count as consent
under GDPR. Decide whether EU/UK accounts start with training off, or rely on
another basis.]

## 4. Training data

- **The setting.** "Help improve ytimesy" is shown during onboarding and is
  **on by default**. You can change it at any time in Settings, Privacy. You
  can also exclude a single project in its settings.
- **What we use when it is on**, from chats that run while it is on and are
  not in an excluded project:
  - your prompts and messages;
  - your code and repository context;
  - results: command and test output, whether pull requests were merged,
    your edits and your feedback.
- **What we never use**, whatever the setting:
  - AI models' replies and model-generated code, from any provider;
  - credentials and secrets (model keys, subscription tokens, GitHub tokens,
    project secrets, environment variables, MCP sign-ins).
- **When it is off**, we use nothing from your chats for training. Turning it
  off stops use of new chats from then on. [OWNER/COUNSEL: state what happens
  to data already collected while it was on; follow the Training Data
  policy.]
- We do not sell training data and do not give it to model providers or
  others for their own use.

Full details, including de-identification and retention, are in the
[Training Data](./training-opt-in.md) policy.

## 5. Model providers and subscriptions

Agents run on the model you pick. When an agent runs, ytimesy sends your
prompt, conversation history, and the code, files and tool output the agent
needs **to the provider you chose**:

- **Your API key or endpoint** (for example OpenAI, Anthropic, Google Gemini,
  OpenRouter, or an OpenAI-compatible endpoint you set): the provider
  processes the request under **your** agreement with it, including its
  retention and training policies. With OpenRouter, the request also goes to
  the model host OpenRouter routes it to.
- **Your subscription** (for example ChatGPT/Codex through ChatGPT sign-in,
  Claude through Claude Code with your own setup token, or xAI/Grok): requests
  are sent to that provider on your account, under your agreement and
  settings with it.

Your keys and sign-in tokens are stored encrypted. Where ytimesy sends
requests to a provider through our own servers, the credential stays on our
side and is not placed on the agent's machine.

We do not control how these providers handle data. Check your provider's
settings if you want them not to retain or train on your data. We do not have
zero-data-retention agreements with model providers, because the agreement
for your traffic is yours, not ours.

ytimesy itself uses **Cloudflare Workers AI** to create embeddings of your
memory notes. [COUNSEL: confirm Cloudflare's current Workers AI terms on
training and retention.]

## 6. GitHub

The ytimesy GitHub App works only on the accounts and repositories you choose
when you install it. It asks for: repository contents (read and write), pull
requests (read and write), checks (read), issues (read), actions (read) and
metadata (read) [OWNER: confirm against the production App's settings]. We use
this to clone your code into your workspace, push branches, open and update
pull requests, read check results and CI job logs, and read comments that
mention the ytimesy GitHub App on pull requests ytimesy opened, so your chat
can fix a failed check or follow a collaborator's request. The agent does not
merge pull requests. You can change the App's repositories or uninstall it at
any time in GitHub settings.

Pull request descriptions written by the agent may link to evidence pages on
ytimesy; those pages need a ytimesy sign-in and are visible only to you.
[OWNER: confirm; reviewers on the repo cannot see them today.]

## 7. Who else receives data (subprocessors)

We use these providers to run ytimesy. Each processes data only to provide its
service to us.

| Provider | What it does for us | Data | Location |
|---|---|---|---|
| Cloudflare, Inc. | Web app and API hosting (Workers, Durable Objects), private object storage (R2: encrypted chat checkpoints, encrypted attachments, pull request evidence), memory repositories, memory embeddings (Workers AI), outbound email, bot checks (Turnstile), network egress, logs | All categories above | Global; storage [OWNER: confirm R2 location] |
| Supabase, Inc. | Main database (Postgres): account, projects, chats, usage, encrypted credentials | Account, content, credentials (encrypted), usage | United States (AWS us-east-2, Ohio) |
| Freestyle | Workspace virtual machines and their snapshots | Repository copies, workspace files, command output, secrets you inject | [OWNER: confirm region] |
| PostHog, Inc. | Product analytics and masked session replay | Account id, product events, masked replay | United States |
| GitHub, Inc. | Sign-in and repository access | Account, repository content | United States |
| Google LLC | Sign-in with Google (if you use it) | Account | United States |

**Providers you choose.** Model providers you connect (for example OpenAI,
Anthropic, Google, xAI, OpenRouter and its hosts, or your own endpoint)
receive prompts, code and tool output for each turn. They act under your
agreement with them, not as our subprocessors; we list them for transparency.

We will update this list before adding a subprocessor [OWNER: and notify
users in the app or by email N days ahead?].

We may also disclose data if required by law, to protect people or the
service, or as part of a merger or acquisition (with notice to you).

## 8. How long we keep it

| Data | Kept |
|---|---|
| Account, projects, chats, tool output, usage | Until you delete them or your account |
| Workspace VM | Stopped after about 1 hour idle |
| Saved workspace snapshot of an idle chat | Up to 90 days, then deleted; or sooner when you delete the chat, project or account |
| Chat checkpoints and attachments (encrypted) | Until you delete the chat, project or account |
| Pull request evidence | 30 days, or until the pull request closes, whichever is first; or when you delete the project or account |
| Memory repository and embeddings | Until you clear memory or delete your account |
| Credentials, keys, secrets | Until you remove them or delete your account |
| Pending sign-in records (email codes, device codes) | Until used or expired |
| Training data (only if the setting was on) | See [Training Data](./training-opt-in.md) |
| Analytics events and replays | Per PostHog retention [OWNER: set and state, e.g. 12 months events, 30 days replay] |
| Hosting logs | Per provider default [OWNER: state, e.g. up to 30 days] |
| Backups held by our database provider | Rolled off within [OWNER: confirm Supabase backup window] |

## 9. Deleting your data

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
  everywhere. Records we must keep by law are kept.
  [OWNER/COUNSEL: state whether training data already collected is deleted
  with the account; match the Training Data policy.]
- Deleting your ytimesy account **does not** uninstall the GitHub App, revoke
  your sign-ins at model providers, or delete data your model provider holds.
  Uninstall or revoke those directly.
- Copies in provider backups and logs age out on their normal schedule.

## 10. Your rights

Depending on where you live (including the EU, UK and California) you may
have the right to access, correct, delete, or receive a copy of your data, to
object to or restrict some processing, and to withdraw consent. Most of this
you can do yourself in the app, including turning training use off. For
anything else, email [OWNER: privacy@ytimesy.com]. We may need to verify your
identity. We will respond within the time the law requires and will not treat
you differently for exercising a right. If we deny a request, you can appeal by
replying to our answer. EU/UK users can complain to their data protection
authority.

We do not sell or "share" personal information for cross-context behavioural
advertising as those terms are defined in California law. [COUNSEL: confirm
whether on-by-default training use needs any further California notice or
opt-out wording.]

## 11. Security

Credentials, keys, secrets, chat checkpoints and attachments are encrypted at
the application level before storage, in addition to provider encryption at
rest. Database tables are not reachable from the browser directly. Each chat
runs in its own virtual machine. Traffic is encrypted in transit. No system is
perfectly secure; if a breach affects your data we will notify you as the law
requires. Report vulnerabilities to [OWNER: security@ytimesy.com].

## 12. International transfers

We are based in [OWNER/COUNSEL: country] and our providers process data in the
United States and elsewhere. Where the law requires, we rely on the providers'
Standard Contractual Clauses, the UK International Data Transfer Addendum, or
the EU-US Data Privacy Framework. [COUNSEL: confirm the mechanism per
provider.]

## 13. Changes

We may update this policy. When we do, we will update the date above and show
a notice to signed-in users in the app. If you keep using ytimesy after a
change applies, the updated policy applies. **A policy change will never turn
training use back on for you if you turned it off**; that needs your own
action in Settings.

## Contact

[OWNER: privacy@ytimesy.com, legal entity, postal address; EU/UK
representative if required.]
