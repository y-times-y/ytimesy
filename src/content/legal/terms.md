# ytimesy Terms of Service (draft)

> DRAFT, NOT LEGAL ADVICE. Written by an engineer/AI from the product's code and
> the current Cursor and Capy terms (read on their websites, 2026-11-02).
> Counsel must review before it takes effect. Items marked
> `[OWNER/COUNSEL: ...]` need a decision.

Last updated: [DATE]. Effective: [DATE].

These terms are an agreement between you and [OWNER/COUNSEL: legal entity name,
e.g. "ytimesy, Inc.", and registered address] ("ytimesy", "we", "us").

**By creating an account or signing in, you agree to these Terms and
acknowledge the [Privacy Policy](./privacy.md).** If you do not agree, do not
create an account or use ytimesy. If you use ytimesy for an organization, you
confirm you can bind it, and "you" includes it.

## 1. The service, and the beta

ytimesy runs AI coding agents in cloud workspaces connected to your GitHub
repositories. Agents read and change code, run commands, and can open pull
requests.

ytimesy is in **free beta**. During the beta:

- We charge nothing. There are no payments.
- Usage limits apply. Each account has a 5-hour window and a weekly window.
  When a window is used up, new work pauses until it resets. We set these
  limits and may change them.
- It is provided **as is and as available**. Features can change, break, be
  limited, or be removed without notice. There is no uptime commitment. Do not
  rely on ytimesy for production-critical work.
- If you connect your own model key or subscription, that provider may charge
  you (see section 5). That is between you and the provider.
- If we introduce paid plans, we will tell you before charging anything, and
  paid use will need your separate agreement.

## 2. Who can use ytimesy

- You must be at least **18 years old**, or the age of majority where you live
  if that is higher. ytimesy is for professional software work. It is not for
  children.
- By creating an account, you confirm you meet this age requirement and can
  form a binding contract.
- If we learn or have reason to believe that an account belongs to someone
  under 18, we will close the account and delete its data as described in the
  Privacy Policy. If you believe a minor has an account, contact
  [OWNER: support@ytimesy.com].
- You may not use ytimesy if you are barred by sanctions or export laws, or if
  we have previously removed you from the service.

[OWNER/COUNSEL: Cursor and Capy both require 18 or the age of majority if
higher. Cursor investigates and "if appropriate" deletes; this draft commits to
closing the account. Confirm.]

## 3. Your account

- Keep your sign-in secure. You are responsible for activity in your account
  and for the repositories, secrets, model keys and subscriptions you connect.
- One person per account. Do not share accounts or create extra accounts to
  get around limits.
- Tell us promptly at [OWNER: security@ytimesy.com] if you think your account
  was accessed without permission.

## 4. Your content and output

"Your content" means what you provide or connect: code, repositories, prompts,
messages, files, secrets and memory. "Output" means what the agents produce
for you: code, diffs, pull requests, messages, screenshots and recordings.

- **You own your content.** As between you and us, you keep all rights in it.
- **You own the output made for you.** To the extent we have any rights in
  output, we assign them to you.
- You give us a limited licence to host, copy, process, transmit and display
  your content and output **only to provide, secure and support the service
  for you, to enforce these Terms, and to comply with law**, and, if training
  use is on, as described in section 6.
- You confirm you have the rights to connect the repositories and content you
  give ytimesy, including code owned by an employer or client.
- Output can be wrong, insecure, or similar to output produced for others.
  Model output may not be protectable by copyright in every country. You are
  responsible for reviewing it.

## 5. Models, subscriptions and third-party services

- Agents run on models you choose and connect. You can connect your own API
  keys (for example OpenAI, Anthropic, Google Gemini, OpenRouter, or an
  OpenAI-compatible endpoint) and your own subscriptions (for example
  ChatGPT/Codex through ChatGPT sign-in, Claude through Claude Code with a
  setup token you create, and xAI/Grok).
- When an agent runs, we send the request to the provider you chose. **That
  provider's terms and policies apply to your use**, including how it bills
  you, retains data, and handles abuse.
- **You are responsible for making sure your provider's terms allow you to use
  your key or subscription through ytimesy.** We are not responsible if a
  provider limits, suspends or closes your account, or charges you, because of
  that use.
- We store the keys and sign-in tokens you connect encrypted. Where ytimesy
  sends requests to a provider through our own servers, the credential stays
  on our side and is not placed on the agent's machine.
- GitHub, Google and other connected services are governed by their own terms.
  We are not responsible for third-party services.

[OWNER/COUNSEL: confirm each subscription route (ChatGPT/Codex, Claude Code
setup token, xAI) is allowed by that provider's current terms for a hosted
product before launch. Capy uses the same "you check your provider allows
it" model.]

## 6. Training data

- ytimesy has a **"Help improve ytimesy"** setting. It is shown to you during
  onboarding and is **on by default**. You can change it at any time in
  Settings, Privacy.
- **When it is on**, we may use these from your chats to improve ytimesy's
  agents and to train or evaluate models: your prompts and messages, your code
  and repository context, and results (command and test output, whether pull
  requests were merged, your edits and your feedback).
- **We never use AI models' replies or model-generated code as training data**,
  from any provider, whether the setting is on or off.
- **When it is off**, we use nothing from your chats for training.
- You can exclude a single project from training in its settings.
- Credentials and secrets are never training data.
- Details are in the [Training Data](./training-opt-in.md) policy and the
  Privacy Policy.

[COUNSEL: Cursor and Capy both promise no training without explicit
agreement. An on-by-default setting is an opt-out model. Confirm it is
acceptable, and whether EU/UK users need it off until they turn it on.]

## 7. GitHub access

- Signing in with GitHub only reads your profile and email address.
- To work on repositories you install the ytimesy GitHub App on the accounts
  and repositories **you select**. Agents use it to clone code, push branches,
  and open or update pull requests. The App's permissions are listed in the
  Privacy Policy. Agents do not merge pull requests.
- You can uninstall the App or remove repositories at any time in GitHub.

## 8. Agents act for you; review their work

Agents can run arbitrary commands in your workspace, change files, install
packages, browse the web and push branches. **You are responsible for reviewing
agent changes before you merge, deploy or rely on them**, and for actions agents
take on your instructions using credentials you provide. Do not give agents
production credentials or access you are not prepared for them to use. Keep
your own backups; ytimesy workspaces are not a backup.

## 9. Acceptable use

Do not use ytimesy, its workspaces or agents to:

- break the law, infringe others' rights, or handle data you are not allowed
  to;
- attack, scan, probe or disrupt systems or networks you do not own or have
  permission to test; run denial-of-service, botnets or malware;
- probe, scan or test the security of ytimesy itself without our written
  permission (report vulnerabilities to [OWNER: security@ytimesy.com]);
- send spam or phishing, or create fraudulent or deceptive content;
- mine cryptocurrency, run proxies or VPNs for others, or use workspaces as
  general-purpose or production hosting unrelated to software development;
- get around usage limits, rate limits, security controls, or another user's
  isolation; access another account's data;
- use someone else's keys, sign-ins or subscriptions without permission, or
  share a personal subscription in a way its provider does not allow;
- scrape or extract data from ytimesy, or reverse engineer it, except as the
  law allows;
- use ytimesy or its output to build or train a competing product or model,
  except where the law does not allow this restriction;
- generate child sexual abuse material or content that exploits minors;
- resell the service;
- violate your model provider's or GitHub's terms.

We may suspend workspaces or accounts to stop abuse, protect the service, or
comply with law, where possible with notice.

## 10. Feedback

If you send ideas or feedback, we may use them without obligation to you.

## 11. Copyright complaints

Send notices of claimed infringement to [OWNER/COUNSEL: designated DMCA agent
name, address, and legal@ or dmca@ytimesy.com; register the agent with the US
Copyright Office]. We remove infringing content and terminate repeat infringers
where appropriate.

## 12. Ending your use

- You can delete your account at any time in Settings. This deletes your data
  as described in the Privacy Policy.
- We may suspend or end your access for breach of these terms, for risk to the
  service or others, if a provider or the law requires it, or if we end the
  beta or the service. If we shut down the service we will try to give you at
  least [30] days' notice.
- Sections 4, 10, 13, 14, 15 and 16 survive termination.

## 13. Disclaimers

TO THE FULLEST EXTENT PERMITTED BY LAW, YTIMESY AND ALL OUTPUT ARE PROVIDED "AS
IS" AND "AS AVAILABLE", WITHOUT WARRANTIES OF ANY KIND, INCLUDING
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY,
OR THAT THE SERVICE WILL BE UNINTERRUPTED, SECURE, OR THAT DATA WILL NOT BE
LOST. WE DO NOT WARRANT THIRD-PARTY SERVICES OR MODEL PROVIDERS.

## 14. Limitation of liability

TO THE FULLEST EXTENT PERMITTED BY LAW: (a) WE ARE NOT LIABLE FOR INDIRECT,
INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR LOST PROFITS,
REVENUE, DATA OR GOODWILL; AND (b) OUR TOTAL LIABILITY FOR ALL CLAIMS RELATING
TO THE SERVICE IS LIMITED TO THE GREATER OF THE AMOUNT YOU PAID US IN THE 12
MONTHS BEFORE THE CLAIM AND US$100. Some places do not allow these limits, so
they may not fully apply to you.

[OWNER/COUNSEL: Cursor: greater of 6 months' fees or $100, and "no liability
whatsoever" for beta services. Capy: greater of 12 months' fees for the
service giving rise to the claim, or $100.]

## 15. Indemnity

You will defend and indemnify us against third-party claims arising from your
content, your repositories, your use of output, your use of connected keys and
subscriptions, or your breach of these terms or the law.

## 16. Disputes and governing law

[OWNER/COUNSEL: choose. Current peers: Cursor uses Texas law and courts
(Wichita or Tarrant County), a class waiver, and no arbitration. Capy uses
California law, San Francisco courts, a 30-day informal step, and binding
individual JAMS arbitration with a class waiver. Default suggestion for a
small US company: the law of the state of incorporation, courts there, an
informal 30-day step first, individual claims only; decide on arbitration with
counsel. EU/UK consumers keep mandatory local rights.]

## 17. Changes to these terms

We may update these terms. When we do, we will update the date above and show
a notice to signed-in users in the app [OWNER: and by email for material
changes?]. Material changes apply [14] days after notice, except where a
change is required by law or addresses abuse. If you keep using ytimesy after
a change applies, you accept it. If you do not agree, stop using ytimesy and
delete your account.

## 18. General

These terms (with the Privacy Policy and any policies they link) are the whole
agreement. If a part is unenforceable the rest stays in force. Not enforcing a
term is not a waiver. You may not assign these terms without our consent; we
may assign them in a merger, acquisition or sale of assets, with notice.

## Contact

[OWNER: support@ytimesy.com / legal@ytimesy.com, postal address.]
