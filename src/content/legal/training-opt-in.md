# Training Data Opt-In (draft)

> DRAFT, NOT LEGAL ADVICE. This is both the user-facing explanation and the
> product spec for the setting. Counsel should review the user-facing parts.

## Position

ytimesy does **not** use your code, prompts, chats or workspaces to train or
improve AI models, and does not give them to anyone to do so, **unless
"Help improve ytimesy" is on for your account**. You choose once, up front:

- **New accounts** see a "Help improve ytimesy" card as the last step of
  setup. Its switch starts **on**; you can turn it off right there. Your
  choice (on or off) is recorded only when you press **Continue**, together
  with the version of this policy shown.
- **Accounts created before the card existed**, which never chose, see the
  same card once in the app, switch on. **Continue** records the choice.
  Closing the card records nothing, and the setting stays **off**.
- Until you press Continue (or change it in Settings), the stored setting is
  **off**. We never switch it on for you without your action, including
  through a change to this policy.

You can change it at any time in Settings, Privacy.

[COUNSEL: the switch starts on, but nothing is recorded until the user acts
on the card. Confirm this is valid consent where a pre-set choice is not
(EU/UK GDPR, the Planet49 ruling); if not, start the switch off for those
regions. Terms section 3 and the Privacy Policy say "opt in"; check the
wording still holds.]

## What "training data" means for us

When the setting is on, **training data** is what **you** and **your
environment** contributed to chats that ran while it was on: your prompts,
your code, and the results. We **never** use AI models' replies or the code
they generate as training data.

Included:

- your prompts and messages;
- your code as it was in the repository before the agent changed it (files
  the agent read);
- results from your environment: command and test output, exit codes, which
  files changed, and outcomes such as a pull request being merged or closed;
- your feedback on a turn (thumbs up/down, corrections), if we add it.

It does **not** include, even when the setting is on:

- **anything an AI model wrote**, from any provider or route (OpenAI,
  Anthropic, xAI, OpenRouter, Codex, Claude Code, Grok subscriptions, or our
  own models): replies, reasoning, plans, the commands and tool arguments it
  chose, the code and diffs it generated, a helper agent's reports, and files
  the agent changed when they are read back. This also keeps us within
  providers' terms, such as Anthropic's and xAI's bar on using their models'
  output to train other models;
- a local agent session you continued in ytimesy (its transcript holds model
  replies);

- credentials of any kind: model keys, ChatGPT/Codex tokens, GitHub tokens,
  project secrets, environment variables, MCP sign-ins (excluded by design,
  then scrubbed again; see below);
- message attachments or pull request evidence media (screenshots,
  recordings) [OWNER: include later only with a separate, explicit choice];
- your memory repository;
- whole repositories or workspace snapshots beyond what the agent read
  during the chat;
- chats in a project you have marked "Never use for training" (see Scope);
- anything from chats that ran while the setting was off.

## What we use it for

Only:

1. improving ytimesy's agent harness (prompts, tools, workflows) and building
   evaluation sets that test it;
2. training or fine-tuning models that ytimesy builds or commissions to power
   ytimesy.

We will **not** sell training data, and will not give it to model providers or
other third parties for their own use. Service providers who store or process
it for us (see the subprocessor list) act only on our instructions.
[OWNER: if you ever want to share opted-in data with a model lab, that needs a
new, separate opt-in; do not stretch this one.]

## De-identification

Before opted-in content is copied into a training store, we:

- drop account identifiers (replace user, project and chat ids with random
  ids that cannot be linked back), names and emails;
- scan for and remove secrets (API keys, tokens, private keys, passwords,
  connection strings) using pattern and entropy detection, and drop any record
  where a secret was found in a place we cannot safely redact;
- remove values of every project secret and credential known for that account
  by exact match;
- strip repository owner/name and remote URLs [OWNER: decide whether repo
  names are kept for public repos].

Code itself can still identify you or your employer. That is why this is
opt-in, and why you should leave it off for code you are not allowed to share.

## Withdrawal (turning it off)

- Turning the setting off takes effect immediately for new chats and for new
  turns in existing chats.
- Content not yet copied to the training store is never copied.
- Content already copied is deleted from the training store within
  [OWNER: 30] days of turning it off or deleting the account.
- Models already trained, and aggregate statistics already computed, cannot be
  "untrained"; we will not use your content in any new training run after you
  turn the setting off.
- Deleting your account turns the setting off and triggers the deletion above.

## Scope: account and project

- **Account setting** "Help improve ytimesy": stored off until you choose.
  The setup card (switch on, recorded on Continue) and Settings are the only
  ways to turn it on.
- **Project override** "Never use this project for training" (default off,
  only shown when the account setting is on). Use it for client or employer
  repositories. A project override can only exclude, never include.
- A chat's eligibility is fixed when each turn runs: account on, project not
  excluded, at turn time. Eligibility applies on every model route; what an
  eligible turn may contribute is the user and environment parts above, never
  model output.
- Organization / team plans (later): an admin can force it off for all
  members. [OWNER: not needed for beta.]

## Copy

### Settings toggle (Settings, Privacy)

> **Help improve ytimesy** (off until chosen)
>
> Let ytimesy use your chats from now on, including your prompts, your code
> and its results (such as test output and merged pull requests), to improve
> our agents and train our own models. We never use replies or code written
> by AI models. We remove account details and secrets first, and never
> share it with model providers. Your API keys, secrets and attachments are
> never included. Turn this off any time; we stop immediately and delete what
> we kept within 30 days. [Learn more](/training)

Confirmation dialog when turning it on:

> **Share your chats to improve ytimesy?**
>
> New chats will be eligible. Leave this off for code you are not permitted to
> share, or exclude those projects in project settings.
>
> [Cancel] [Turn on]

Project settings, when the account setting is on:

> **Never use this project for training** (off)
>
> Chats in this project are never used to improve ytimesy, even though your
> account setting is on.

### Setup card (last step of setup; shown once to older accounts)

> **Help improve ytimesy** [switch, on]
>
> Uses your chats to improve our models. [Learn more](/training)
>
> You can change this anytime in Settings → Privacy.
>
> [Continue]

- Continue records the switch as shown (on or off), the policy version, and
  source `onboarding`.
- For older accounts it is a small, non-blocking card. Closing it (the X)
  records no consent, leaves the setting off, and the card does not return.
- An account that already chose (any `training_consent` row) never sees it.

## Schema and product requirements

```sql
-- Account-level consent; absence of a row = off.
create table training_consent (
  user_id text primary key references auth_user(id) on delete cascade,
  enabled boolean not null default false,
  policy_version text not null,          -- version of this document shown
  changed_at timestamptz not null default now(),
  source text not null check (source in ('settings','onboarding'))
);
-- The setup card was closed without Continue: not consent, only "seen".
create table training_prompt_dismissal (
  user_id text primary key references auth_user(id) on delete cascade,
  dismissed_at timestamptz not null default now()
);
-- Append-only audit of every change (proof of consent and withdrawal).
create table training_consent_event (
  id uuid primary key,
  user_id text not null,                 -- no FK: survives account deletion as proof
  enabled boolean not null,
  policy_version text not null,
  source text not null,
  created_at timestamptz not null default now()
);
-- Project exclusion.
alter table project add column training_excluded boolean not null default false;
-- Per-turn stamp, set when the turn starts.
alter table api_turn add column training_eligible boolean not null default false;
```

- `training_eligible` is computed server-side at turn start
  (`consent.enabled and not project.training_excluded`) and never changed
  afterwards except to `false` on withdrawal.
- Export to a training store copies only `training_eligible` turns, and from
  them only the parts `trainingExportParts` (src/domain/training-data.ts)
  keeps: user and environment parts, never model output. Then
  de-identification, into a separate bucket keyed by a random id, with a
  mapping table (user id to random ids) used only for withdrawal deletion.
- Withdrawal and account deletion enqueue deletion of that user's rows in the
  training store; a daily job enforces the 30-day bound.
- `training_consent_event.user_id` should be hashed after account deletion
  [COUNSEL: confirm retention of consent proof].
- No export pipeline exists today; until one ships, the setting can exist with
  no data leaving production, which is fine.
