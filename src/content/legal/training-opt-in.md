# Training Data

Last updated: 2026-11-02.

This page explains the "Help improve ytimesy" setting: what it lets ytimesy
use, what it never uses, and where things stand today. It is part of our
[Privacy Policy](./privacy.md).

## Your choice

- **New accounts** see a "Help improve ytimesy" card as the last step of
  setup. Its switch starts **on** (**off** if you are in the EU, EEA, UK or
  Switzerland); you can change it right there. Your
  choice (on or off) is saved only when you press **Continue**, together with
  the version of this policy shown.
- **Accounts created before the card existed**, which never chose, see the
  same card once in the app, with the same starting position. **Continue**
  saves the choice.
  Closing the card saves nothing, and the setting stays **off**.
- Until you press Continue or change it in Settings, the setting is **off**.
  A change to this policy never turns it on for you.
- You can change it at any time in **Settings → Privacy**. Turning it on there
  asks you to confirm first.
- When the setting is on, each project's settings show **"Never use this
  project for training"**. Use it for client or employer repositories. A
  project setting can only exclude a project, never include one.

Whether a turn is eligible is decided when the turn starts: the setting is on
and the project is not excluded. This applies on every model route.

## What can be used

When the setting is on, these parts of chats that ran while it was on can be
used. They are what **you** and **your environment** contributed:

- your prompts and messages;
- your code and repository context: file contents and command output as they
  were before the agent changed those files;
- results from your environment: command and test output, exit codes, which
  files changed (paths and line counts), errors, and pull request outcomes
  such as merged or closed;
- feedback you give on a turn (ytimesy has no feedback control yet).

## What is never used

Even when the setting is on, these are never training data:

- **anything an AI model wrote**, from any provider or route (OpenAI,
  Anthropic, xAI, OpenRouter, Google, ChatGPT/Codex, Claude Code and Grok
  subscriptions): replies, reasoning, plans, questions, the commands and tool
  arguments it chose, web searches it ran, the code and diffs it generated, a
  subagent's reports, and files the agent changed when they are read
  back;
- a local agent session you continued in ytimesy (its transcript holds model
  replies);
- message attachments and pull request evidence (screenshots, recordings);
- your memory repository;
- credentials stored in ytimesy: model keys, subscription tokens, GitHub
  tokens, project secrets, MCP sign-ins. They are kept outside chats;
- chats in a project marked "Never use this project for training";
- anything from turns that ran while the setting was off.

A secret that appears inside a chat, for example pasted into a message or
printed by a command, is part of that chat. ytimesy does not yet remove such
secrets automatically. Leave the setting off, or exclude the project, for code
with secrets or code you are not allowed to share.

## What it is for

Only:

1. improving ytimesy's agents (prompts, tools, workflows) and building
   evaluation sets that test them;
2. training or fine-tuning models that ytimesy builds or commissions to power
   ytimesy.

We do not sell training data, and we do not give it to model providers or
other third parties for their own use.

## Where things stand today

There is no training export yet. When the setting is on, eligible turns are
marked as eligible in our main database and stay there like any other chat.
Nothing has been copied out for training, and no model has been trained on
them. Before we copy any eligible data for training, we will update this
policy to say how it is de-identified, stored and deleted.

## Turning it off

- Turning the setting off takes effect at once for new turns, and marks every
  earlier turn of yours as not eligible at the same moment.
- Excluding a project marks that project's earlier turns as not eligible.
- Deleting your account deletes your chats and your setting. We keep the
  history of your setting changes (on, off, when, and the policy version) as
  proof of consent and withdrawal.

## Schema and product requirements

Internal notes, not published (src/routes/training.tsx cuts the page here).

- Tables: `training_consent` (account setting, no row = off),
  `training_prompt_dismissal` (card closed without Continue),
  `training_consent_event` (append-only history, no foreign key, survives
  account deletion with the user id), `project.training_excluded`,
  `api_turn.training_eligible`.
- `api_turn.training_eligible` is computed when a turn is queued
  (src/server/adapters/training-consent.ts, trainingEligibleAtTurnStart) and
  only ever changed to false: turning the setting off or excluding a project
  clears it on earlier turns.
- Any future export must copy only `training_eligible` turns, and from them
  only the parts `trainingExportParts` (src/domain/training-data.ts) keeps:
  user and environment parts, never model output, never attachments. It must
  also add secret scanning and de-identification, and this policy must be
  updated (with a TRAINING_POLICY_VERSION bump) before it ships.
- The Settings tooltip (TRAINING_DETAILS in
  src/features/workspace/training-consent-settings.tsx) promises removal of
  account details and secrets and deletion within 30 days; those hold only
  once an export exists that does them. Keep it in step with this page.
