# ytimesy Terms of Service (draft)

> DRAFT, NOT LEGAL ADVICE. Written by an engineer/AI from the product's code and
> peer terms (Cursor, [competitor], [competitor]). Counsel must review before it takes
> effect. Items marked `[OWNER/COUNSEL: ...]` need a decision.

Last updated: [DATE]. Effective: [DATE].

These terms are an agreement between you and [OWNER/COUNSEL: legal entity name,
e.g. "ytimesy, Inc.", and registered address] ("ytimesy", "we", "us"). By
creating an account or using ytimesy you agree to them and to our
[Privacy Policy](./privacy.md). If you use ytimesy for an organization, you
confirm you can bind it, and "you" includes it.

## 1. The service, and the beta

ytimesy runs AI coding agents in cloud workspaces connected to your GitHub
repositories. Agents read and change code, run commands, and can open pull
requests.

ytimesy is in **free public beta**. During the beta:

- It is provided **as is and as available**. Features can change, break, be
  limited, or be removed without notice. There is no uptime commitment.
- We cover workspace and hosting costs up to usage caps that we set and may
  change. When a cap is reached, new work pauses.
- You pay your model provider directly (see section 4). We charge you nothing.
  If we introduce paid plans we will tell you before charging anything, and
  paid use will need your separate agreement.

## 2. Eligibility and accounts

- You must be at least **18** [OWNER/COUNSEL: confirm 18; Cursor and [competitor] use
  18] and able to form a binding contract. ytimesy is not for children.
- You may not use ytimesy if you are barred by sanctions or export laws.
- Keep your sign-in secure. You are responsible for activity in your account
  and for the repositories, secrets, model keys and subscriptions you connect.
- One person per account. Do not share accounts or create accounts to get
  around limits.

## 3. Your content

"Your content" means what you provide or connect (code, repositories, prompts,
messages, files, secrets, memory) and what the agents produce for you (code,
diffs, pull requests, messages, screenshots and recordings) ("output").

- **You own your content.** As between you and us, you keep all rights in it,
  and to the extent we have any rights in output we assign them to you.
- You give us a limited licence to host, copy, process, transmit and display
  your content **only to provide, secure and support the service for you**, and
  as described in the Privacy Policy.
- **We do not use your content to train AI models unless you opt in.** Training
  use is off by default; you can turn it on or off at any time in settings. See
  the [Training Data Opt-In](./training-opt-in.md) and the Privacy Policy.
- You confirm you have the rights to connect the repositories and content you
  give ytimesy, including code owned by an employer or client.
- Output can be wrong, insecure, or similar to output produced for others. Model
  output may not be protectable by copyright in every country.

## 4. Models, keys and third-party services

- Agents run on models you choose and connect: your own API keys (OpenAI,
  Anthropic, Google Gemini, OpenRouter, or an OpenAI-compatible endpoint you
  configure) or your ChatGPT/Codex subscription that you sign in to.
- Your use of a model provider is also governed by **your agreement with that
  provider**, which bills you and sets how it handles the data we send on your
  behalf. You are responsible for complying with those terms.
  [OWNER/COUNSEL: confirm that routing a user's ChatGPT subscription through
  ytimesy is permitted by OpenAI's terms before launch.]
- GitHub, Google and other connected services are governed by their own terms.
  We are not responsible for third-party services.

## 5. GitHub access

- Signing in with GitHub only reads your profile and email address.
- To work on repositories you install the ytimesy GitHub App on the accounts
  and repositories **you select**. The App requests: repository contents (read
  and write), pull requests (read and write), checks (read) and metadata (read)
  [OWNER: confirm against the production App's settings]. Agents use this to
  clone code, push branches, and open or update pull requests. We do not push
  to your default branch on our own initiative and do not merge pull requests.
- You can uninstall the App or remove repositories at any time in GitHub.

## 6. Agents act for you; review their work

Agents can run arbitrary commands in your workspace, change files, install
packages, browse the web and push branches. **You are responsible for reviewing
agent changes before you merge, deploy or rely on them**, and for actions agents
take on your instructions using credentials you provide.

## 7. Acceptable use

Do not use ytimesy, its workspaces or agents to:

- break the law, infringe others' rights, or handle data you are not allowed to;
- attack, scan, probe or disrupt systems or networks you do not own or have
  permission to test; run denial-of-service, botnets, or malware;
- send spam or phishing, or create fraudulent or deceptive content;
- mine cryptocurrency, run proxies or VPNs for others, or use workspaces as
  general-purpose hosting unrelated to software development;
- get around usage caps, rate limits, security controls, or another user's
  isolation; access another account's data;
- generate child sexual abuse material or content that exploits minors;
- reverse engineer the service except as the law allows, or resell it;
- violate your model provider's or GitHub's terms.

We may suspend workspaces or accounts to stop abuse, protect the service, or
comply with law, where possible with notice.

## 8. Feedback

If you send ideas or feedback, we may use them without obligation to you.
Feedback is not "training data" unless you opt in; see section 3.

## 9. Copyright complaints

Send notices of claimed infringement to [OWNER/COUNSEL: designated DMCA agent
name, address, and legal@ or dmca@ytimesy.com; register the agent with the US
Copyright Office]. We remove infringing content and terminate repeat infringers
where appropriate.

## 10. Ending your use

- You can delete your account at any time in settings; this deletes your data
  as described in the Privacy Policy.
- We may suspend or end your access for breach of these terms, for risk to the
  service or others, or if we end the beta or the service. If we shut down the
  service we will try to give you at least [30] days' notice.
- Sections 3 (ownership), 8, 11, 12, 13 and 14 survive termination.

## 11. Disclaimers

TO THE FULLEST EXTENT PERMITTED BY LAW, YTIMESY AND ALL OUTPUT ARE PROVIDED "AS
IS" AND "AS AVAILABLE", WITHOUT WARRANTIES OF ANY KIND, INCLUDING
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY,
OR THAT THE SERVICE WILL BE UNINTERRUPTED, SECURE, OR THAT DATA WILL NOT BE
LOST. Keep your code in GitHub; ytimesy workspaces are not a backup.

## 12. Limitation of liability

TO THE FULLEST EXTENT PERMITTED BY LAW: (a) WE ARE NOT LIABLE FOR INDIRECT,
INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR LOST PROFITS,
REVENUE, DATA OR GOODWILL; AND (b) OUR TOTAL LIABILITY FOR ALL CLAIMS RELATING
TO THE SERVICE IS LIMITED TO THE GREATER OF THE AMOUNT YOU PAID US IN THE 12
MONTHS BEFORE THE CLAIM AND US$100. Some places do not allow these limits, so
they may not fully apply to you.

[OWNER/COUNSEL: peers use the same structure: Cursor and [competitor]: greater of
6 months' fees or $100; [competitor]: 12 months' fees for the service giving rise to the claim, or $100.
Cursor's beta clause goes further ("no liability whatsoever" for betas).]

## 13. Indemnity

You will defend and indemnify us against third-party claims arising from your
content, your repositories, or your breach of these terms or the law.

## 14. Disputes and governing law

[OWNER/COUNSEL: choose. Options seen in peers: Cursor uses Texas law and
courts (Wichita or Tarrant County), a 45-day informal step, class waiver, no
arbitration; [competitor] uses California law and binding
individual JAMS arbitration with class waiver; [competitor] uses New York law and
AAA-ICDR arbitration. Default suggestion for a small US company: the law of the
state of incorporation, courts there, an informal 30-day resolution step first,
individual claims only; decide on arbitration with counsel. EU/UK consumers keep
mandatory local rights.]

## 15. Changes to these terms

We may update these terms. For material changes we will notify you by email or
in the app at least [14] days before they apply, except where a change is
required by law or addresses abuse. Continuing to use ytimesy after that means
you accept the change. **We will never switch training use on for you through a
terms change**; that needs your own action in settings.

## 16. General

These terms (with the Privacy Policy and any policies they link) are the whole
agreement. If a part is unenforceable the rest stays in force. Not enforcing a
term is not a waiver. You may not assign these terms without our consent; we
may assign them in a merger, acquisition or sale of assets, with notice.

## Contact

[OWNER: support@ytimesy.com / legal@ytimesy.com, postal address.]
