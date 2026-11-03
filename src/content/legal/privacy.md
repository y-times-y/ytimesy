# ytimesy Privacy Policy

Last updated: 2026-11-03.

This policy explains what ytimesy ("ytimesy", "we") collects when you use
ytimesy, why, who else receives it, how long we keep it, and your choices. It
is part of our [Terms of Service](./terms.md). By creating an account or
signing in, you acknowledge this policy.

## The short version

- We collect what we need to run coding agents on your repositories: your
  account, the repositories you connect, your chats, the files and commands in
  your workspaces, and encrypted credentials you give us.
- Your prompts and the code an agent reads go to **the model provider you
  chose**, under your own key or subscription and your own agreement with that
  provider.
- **Training data.** The "Help improve ytimesy" setting is shown during
  onboarding with its switch **on** (**off** in the EU, EEA, UK and
  Switzerland). When it is on, your prompts and
  messages, your code and repository context, and results can be used to
  improve ytimesy. **We never use AI models' replies or model-generated code
  as training data.** Turn it off at any time in Settings → Privacy. Today no
  training export exists; see [Training Data](./training-opt-in.md).
- Memory is **on by default**; you can turn it off or clear it.
- We record **masked session replays** of how the web app is used, to fix bugs
  and improve the product. Inputs, chat content, code and secrets are masked.
  No replays are recorded in the EU, EEA, UK or Switzerland.
- We do not sell your personal information or use it for advertising.
- You can delete chats, projects, your memory, and your whole account yourself.
- ytimesy is for people 18 and older.

## 1. What we collect

**Account.** Name, email address, profile image, and the identity you sign in
with (email and password, GitHub, or Google). Passwords are stored only as
hashes. GitHub sign-in asks only for your profile and email (`user:email`).
Sign-in tokens from GitHub or Google are stored encrypted. For each signed-in
session we store the IP address and browser user agent. We record which
version of the Terms and this policy you accepted, when, and where (sign-up,
sign-in, or the in-app update notice).

**GitHub connection.** If you install the ytimesy GitHub App, we receive the
list of accounts and repositories you selected and can act on them. If you
connect your GitHub account, we store its access token encrypted. See
section 6.

**Your content.** Prompts and messages, file attachments, the agent's replies
and tool output (commands run, their output, file contents read and written,
diffs), pull requests the agent opens, project settings, notes agents save
about a project, and pull request evidence (screenshots, short screen
recordings and command output captured from a pull request's code). If you
continue a local agent session in ytimesy, we also store the session
transcript you upload; the command-line tool redacts secrets from `.env`
files before uploading.

**Workspaces.** Each chat runs in a cloud virtual machine with a copy of your
repositories, installed dependencies, and anything the agent or you create
there. Read-only helper agents share their chat's machine; machines are not
shared between accounts. Idle workspaces are saved as snapshots so you can
resume (section 9).

**Previews.** Apps an agent runs in your workspace can be opened as previews.
Previews are private to you. If you turn on sharing for a preview, anyone with
its link can open it until you turn sharing off.

**Credentials you give us.** Model API keys, sign-in tokens for subscriptions
you connect (ChatGPT/Codex, a Claude Code setup token, or xAI), project
secrets, and MCP server headers and sign-ins. These are **encrypted** with
application-level encryption before storage and decrypted only to run your
work. Project secrets are placed on your workspace machine when your work
needs them; model keys and subscription tokens are not.

**Memory.** Memory is **on by default**. While it is on, an agent using your
connected model writes notes from your chats (preferences, project facts,
lessons) into a private memory repository for your account, and we create
numeric embeddings of those notes so agents can recall relevant ones. You can
view memory, clear it, or turn it off in settings.

**Training settings.** Whether "Help improve ytimesy" is on, each change with
its time, source and the policy version shown, and which projects you
excluded.

**Usage records.** Which models and runtimes you used, token counts, workspace
time and machine size, and usage against our 5-hour and weekly limits. We take
no payments, so we hold no payment details.

**Product analytics.** We use PostHog. From the web app we send a fixed set of
events (for example "app viewed", "prompt submitted", which inspector panel
was opened, page speed measurements) and error reports (the error and stack
trace with secrets redacted, and the page path). Our servers send events such
as "account created", "turn started/finished", "pull request created" and
agent performance measurements (timings, token counts, tool outcomes). Events
are linked to your account id and do not contain prompts, code or repository
names. IP-based location lookup is turned off. If your browser sends "Do Not
Track", the web app sends no analytics or session replays; server events are
still recorded.

**Referral attribution.** When you first visit, the web app keeps where you
came from (a `ref` or `utm_*` link tag, the referring site's host name and the
page you landed on) in a first-party cookie for 90 days, and when you create an
account we save it with your account and send it to PostHog with the "account
created" event, so we can see which channels bring sign-ups. It is not set for
visitors in the EU, EEA, UK or Switzerland, or under "Do Not Track" or Global
Privacy Control.

**Session replays.** While you are signed in, PostHog records masked
session replays of how you use the web app (clicks, scrolling, which screens
you open), linked to your account id, so we can fix bugs and improve the
product. Replays are masked in
your browser before anything is sent: all text, including chat content, is
masked, every input is masked, and code, diffs, terminals, file contents,
secrets, images, previews and the desktop view are blocked. Sign-in pages, network
traffic and console logs are not recorded. Replays are kept for 30 days and
deleted with your account. **We do not record session replays for people in
the EU, EEA, UK or Switzerland**, based on the country our hosting provider
reports for your connection. To object to replays elsewhere, email us (section
11).

**Logs and bot checks.** Our hosting provider keeps operational logs
(requests, errors, timings) that can include IP addresses and identifiers, for
security and debugging. Email sign-up, sign-in, password reset and
verification resend use Cloudflare Turnstile to block bots.

**Email.** We send account emails (email verification and password reset)
from noreply@ytimesy.com; replies go to support@ytimesy.com. Mail you send to
our addresses is forwarded to a mailbox hosted by Google.

**Cookies and browser storage.** We use a sign-in cookie, a few cookies
that remember interface state (such as open panels) and the referral
attribution cookie described above. The browser also stores
unsent message drafts and the analytics identifier. We
use no advertising cookies.

## 2. Children

ytimesy is not for anyone under 18 (see Terms, section 2). We do not knowingly
collect personal information from anyone under 18. If we learn or have reason
to believe that an account belongs to someone under 18, we delete the account
and its data as described in section 10. If you believe a minor has an
account, contact support@ytimesy.com.

## 3. How we use it

- To provide the service: sign you in, connect repositories, run agents and
  workspaces, save and restore chats, push branches and open pull requests,
  show your history and evidence.
- To call the model you chose with your prompts and the context the agent
  needs.
- To keep your memory, if it is on.
- To enforce usage limits and the Terms, prevent abuse, and keep the service
  secure.
- To support you when you contact us.
- To understand and improve the product using the analytics described above.
- **If "Help improve ytimesy" is on**, to improve ytimesy's agents and to
  train or evaluate models, using only the data listed in section 4.

We look at your code, chats or workspaces only (a) when you ask us to (for
example in a support request), or (b) to investigate abuse, a security
incident or a legal request.

For people in the EU, EEA, UK and Switzerland, see section 11 for our legal
bases.

## 4. Training data

- **The setting.** "Help improve ytimesy" is shown during onboarding with its
  switch **on** (**off** in the EU, EEA, UK and Switzerland), and your choice
  is saved when you continue. Until you make a
  choice there or in Settings, it is off. You can change it at any time in
  Settings → Privacy, and you can exclude a single project in its settings.
- **What can be used when it is on**, from chats that run while it is on and
  are not in an excluded project:
  - your prompts and messages;
  - your code and repository context (files and command output as they were
    before the agent changed them);
  - results: command and test output, exit codes, which files changed,
    pull request outcomes, and feedback you give on a turn.
- **What is never used**, whatever the setting:
  - AI models' replies and model-generated code, from any provider;
  - attachments, your memory, and imported local agent sessions;
  - credentials stored in ytimesy (model keys, subscription tokens, GitHub
    tokens, project secrets, MCP sign-ins), which are kept outside chats.
- A secret that appears inside a chat (for example pasted into a message or
  printed by a command) is part of that chat. ytimesy does not yet remove such
  secrets automatically, so keep the setting off, or exclude the project, for
  code with secrets or code you are not allowed to share.
- **When it is off**, nothing from your chats is used. Turning it off marks
  every earlier chat of yours as not eligible at once.
- **Today**, eligible chats stay in our main database like any other chat.
  Nothing has been copied out for training, and no model has been trained on
  them. We will update this policy before we copy eligible data for training.
- We do not sell training data and do not give it to model providers or
  others for their own use.

## 5. Model providers and subscriptions

Agents run on the model you pick. When an agent runs, ytimesy sends your
prompt, conversation history, attachments, and the code, files and tool output
the agent needs **to the provider you chose**:

- **Your API key or endpoint** (OpenAI, Anthropic, Google Gemini, OpenRouter,
  or an OpenAI-compatible endpoint you set): the provider processes the
  request under **your** agreement with it, including its retention and
  training policies. With OpenRouter, the request also goes to the model host
  OpenRouter routes it to. Web search, where available, is the provider's own
  search.
- **Your subscription** (ChatGPT/Codex through ChatGPT sign-in, Claude through
  a Claude Code setup token, or Grok through xAI sign-in, where offered):
  requests are sent to that provider on your account, under your agreement and
  settings with it. ChatGPT requests can pass through relay servers that run
  our code on their way to OpenAI.

Your keys and sign-in tokens are stored encrypted and used by our servers;
they are not placed on your workspace machine. For a Claude subscription, the
machine holds only a short-lived grant for the current turn, and our server
swaps in your token when forwarding to Anthropic.

We do not control how these providers handle data. Check your provider's
settings if you want them not to retain or train on your data. We do not have
zero-data-retention agreements with model providers, because the agreement
for your traffic is yours, not ours.

ytimesy itself uses **Cloudflare Workers AI** to create embeddings of your
memory notes.

## 6. GitHub

The ytimesy GitHub App works only on the accounts and repositories you choose
when you install it. Our App configuration asks for: repository contents
(read and write), pull requests (read and write), checks (read), issues
(read), actions (read) and metadata (read). GitHub shows the exact permissions
before you install. We use this to clone your code into your workspace, push
branches, open and update pull requests, read check results and CI job logs,
and read comments that mention the ytimesy GitHub App on pull requests ytimesy
opened, so your chat can fix a failed check or follow a collaborator's
request. Agents do not merge pull requests; you can merge one yourself from
ytimesy's pull request panel. You can change the App's repositories or
uninstall it at any time in GitHub settings.

Pull request descriptions written by the agent may link to evidence pages on
ytimesy. Those pages and their files are visible only to you, signed in to
ytimesy; other people on the repository cannot open them.

## 7. Who else receives data (subprocessors)

We use these providers to run ytimesy. Each processes data only to provide its
service to us.

| Provider | What it does for us | Data | Location |
|---|---|---|---|
| Cloudflare, Inc. | Web app and API hosting (Workers, Durable Objects), private object storage (R2: encrypted chat checkpoints, encrypted attachments, encrypted imported sessions, pull request evidence), memory repositories, memory embeddings (Workers AI), sending email, receiving email, bot checks (Turnstile), network egress, logs | All categories above | Global network; storage location chosen by Cloudflare |
| Supabase, Inc. | Main database (Postgres): account, projects, chats, usage, encrypted credentials | Account, content, credentials (encrypted), usage | United States (AWS us-east-2, Ohio) |
| Freestyle | Workspace virtual machines, previews and machine snapshots | Repository copies, workspace files, command output, project secrets on the machine | Chosen by Freestyle |
| PostHog, Inc. | Product analytics, error reports and masked session replays | Account id, product events, error reports, masked replays | United States |
| Google LLC | Sign-in with Google (if you use it); mailbox for email sent to our addresses | Account; email you send us | United States |
| GitHub, Inc. | Sign-in and repository access | Account, repository content | United States |

**Providers you choose.** Model providers you connect (OpenAI, Anthropic,
Google, xAI, OpenRouter and its hosts, or your own endpoint) receive prompts,
code and tool output for each turn. They act under your agreement with them,
not as our subprocessors; we list them for transparency.

We will update this list when we add a subprocessor.

We may also disclose data if required by law, to protect people or the
service, or as part of a transfer of the service (with notice to you).

## 8. Who can see your data in ytimesy

Your projects, chats, memory and evidence are visible only to your account;
ytimesy has no team sharing yet. A preview is visible to others only while
you share its link. Pull requests and commits the agent pushes are visible to
whoever can see the repository on GitHub.

## 9. How long we keep it

| Data | Kept |
|---|---|
| Account, projects, chats, tool output | Until you delete them or your account |
| Deleted (archived) chats and projects | 30 days in Settings → Archived, where you can restore them or delete them for good; then deleted automatically |
| Workspace machine | Pauses after a few minutes without activity. After about 1 hour idle, it is saved as a snapshot (with project secrets removed) and the machine is deleted |
| Saved workspace snapshot | 90 days, then deleted; sooner when you delete the chat, project or account |
| Chat checkpoints, attachments and imported sessions (encrypted) | Until you delete the chat, project or account |
| Pull request evidence | 30 days, or until the pull request is no longer open, whichever is first; sooner when you delete the project or account |
| Memory repository and embeddings | Until you clear memory or delete your account |
| Credentials, keys, secrets | Until you remove them or delete your account |
| Signed-in sessions (with IP address and user agent) | Until you sign out or they expire |
| Sign-in, verification and device-login codes | Until used or expired |
| Training setting changes | The current setting until you delete your account; the change history is kept after deletion as proof of consent and withdrawal |
| Cloud usage ledger (amounts and times, linked to your account id) | Kept after account deletion as our spend record |
| Session replays | 30 days, or until your account is deleted |
| Analytics events | PostHog's retention for our project, or until your account is deleted |
| Referral attribution | The browser cookie for 90 days; on your account until it is deleted |
| Hosting logs | The hosting provider's log retention period |
| Database backups | Rolled off on our database provider's backup schedule |

## 10. Deleting your data

- **Chats and projects**: deleting one archives it for 30 days (restorable in
  Settings → Archived); then, or when you delete it for good there, we delete
  its messages, saved checkpoints, attachments, workspaces and saved workspace
  snapshots, and those of its helper chats. Deleting a project also deletes
  its environment snapshots, imported sessions and pull request evidence. Your
  GitHub repositories are not touched.
- **Memory**: "Clear memory" deletes your memory repository and its
  embeddings.
- **Account**: Settings → Delete account. This immediately deletes your
  account, projects, chats (including archived ones), attachments,
  checkpoints, imported sessions, pull request evidence, workspaces and
  snapshots, memory, credentials and training setting, signs you out
  everywhere, and asks PostHog to delete your analytics person, events and
  session replays. We keep only the training-setting change history and the cloud
  usage ledger described in section 9.
- Deleting your ytimesy account **does not** uninstall the GitHub App, revoke
  your sign-ins at model providers, or delete data your model provider holds.
  Uninstall or revoke those directly.
- Copies in provider backups and logs age out on their normal schedule.

## 11. Your rights

Depending on where you live (including the EU, UK and California) you may
have the right to access, correct, delete, or receive a copy of your data, to
object to or restrict some processing, and to withdraw consent. You can
delete data and turn off training use and memory yourself in the app. ytimesy has no self-serve data export yet; for a copy of your data
or anything else, email support@ytimesy.com. We may need to verify your
identity. We will respond within the time the law requires and will not treat
you differently for exercising a right. If we deny a request, you can appeal by
replying to our answer.

**EU, EEA, UK and Switzerland.** Where the GDPR, the UK GDPR or the Swiss data
protection law applies, our legal bases are:

- **contract**: running the service and your account;
- **legitimate interests**: security, abuse prevention, fixing bugs and
  improving the product, including product analytics (and, outside these
  regions, masked session replays);
- **consent**, only where we ask for it, such as the "Help improve ytimesy"
  setting;
- **legal obligations**.

For people in these regions we do not record session replays, and the
"Help improve ytimesy" switch starts off. You have the right to access,
correct, delete and receive a copy of your data, to restrict processing, to
object to processing (including product analytics), and to withdraw consent at
any time. To exercise a right, email support@ytimesy.com with "Privacy
Request" in the subject. You can also complain to your local data protection
authority. Transfers out of these regions rely on the Standard Contractual
Clauses and the UK International Data Transfer Addendum (section 13).

We do not sell or "share" personal information for cross-context behavioural
advertising as those terms are defined in California law.

## 12. Security

Credentials, keys, secrets, chat checkpoints, attachments and imported
sessions are encrypted at the application level before storage, in addition
to provider encryption at rest. Database tables are not reachable from the
browser directly. Each chat runs in its own virtual machine, and machines are
not shared between accounts. Connections to ytimesy use HTTPS. No system is
perfectly secure; if a breach affects your data we will notify you as the law
requires. Report vulnerabilities to support@ytimesy.com.

## 13. International transfers

Our providers process data in the United States and elsewhere. For transfers
of personal data out of the EU, EEA, UK or Switzerland, we rely on the
European Commission's Standard Contractual Clauses and, for the UK, the
International Data Transfer Addendum, as offered in our providers' data
processing terms.

## 14. Changes

We may update this policy. When we do, we update the date above and show a
notice to signed-in users in the app. If you keep using ytimesy after the
update, the updated policy applies. **A policy change never turns training use
on for you**; that needs your own action.

## Contact

Support, privacy and legal requests: support@ytimesy.com.
