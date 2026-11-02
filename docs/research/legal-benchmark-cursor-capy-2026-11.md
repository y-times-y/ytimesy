# Legal benchmark: Cursor and Capy terms and privacy (2026-11-02)

Primary sources only. Every quote below was fetched on 2026-11-02 from the
company's own domain (raw HTML downloaded with curl, then read). Nothing is
from blogs or memory. "Not found" means the fetched page did not say it.

Used to revise `src/content/legal/terms.md` and `src/content/legal/privacy.md`.
Not legal advice.

## Sources

| Doc | URL | Last updated (as shown on page) |
|---|---|---|
| Cursor Terms of Service | https://cursor.com/terms-of-service | September 3, 2026 |
| Cursor Privacy Policy | https://cursor.com/privacy | October 11, 2026 |
| Cursor Data Use ("Privacy Overview") | https://cursor.com/data-use | September 3, 2026 |
| Cursor Security | https://cursor.com/security | August 25, 2026 |
| Cursor Acceptable Use Policy | https://cursor.com/acceptable-use-policy | August 11, 2026 |
| Cursor subprocessors | https://trust.cursor.com/subprocessors | Not readable (page renders by script; no text fetched) |
| Capy Terms of Service | https://capy.ai/terms-of-service | October 24, 2026 |
| Capy Privacy Policy | https://capy.ai/privacy-policy | October 19, 2026 |
| Capy Acceptable Use Policy | https://capy.ai/acceptable-use-policy | October 15, 2026 |
| Capy Subprocessors | https://capy.ai/subprocessors | October 30, 2026 |
| Capy docs, Security and privacy | https://docs.capy.ai/admin/security.md | No date on page |

Company check: capy.ai is the cloud coding agent ("Capy is the best way to
orchestrate coding agents", https://capy.ai/llms.txt). Its legal entity is
"Scrapybara, Inc.", San Francisco (Terms, first paragraph). Other "Capy"
results (capytech.pages.dev, a WordPress plugin) are different companies and
were ignored.

## Comparison table

| Topic | Cursor (Anysphere, Inc.) | Capy (Scrapybara, Inc.) |
|---|---|---|
| Minimum age | 18, or age of majority if higher (Terms s.2) | 18, or age of majority if higher (Terms, "Accounts and eligibility") |
| Children / COPPA | Privacy: no collection from under-18s; if they learn a user is under 18 they "investigate and, if appropriate, delete the personal data and/or the account". No COPPA mention. | Privacy: "not directed to children under 18"; "If you believe a child has provided personal information to us, contact support@capy.ai". No stated action on discovery. No COPPA mention. |
| Acceptance | Browse-wrap: "By using the Service, you agree to these Terms" | "By creating an account, clicking to accept these Terms, using the Services, ..." |
| Training | Terms: will not train "UNLESS YOU'VE EXPLICITLY AGREED". Data Use page: Privacy Mode off means "we may use and store codebase data, prompts, editor actions, code snippets ..." to train. Default not stated on fetched pages. | Opt-in: no training on non-public Customer Content "unless you explicitly opt in or otherwise agree in writing". |
| AI output in training | Cursor's "Content" = Inputs and Suggestions (outputs); both covered by the training rule. Data Use: inference providers may "temporarily access and store model inputs and outputs". | Customer Content includes "generated responses"; same opt-in rule. Not separately addressed. |
| Output ownership | "assigns to you all of our right ... in and to any Suggestions" (s.5.3) | "you own Output generated specifically for you"; "We assign to you any right ..." |
| Third-party models / BYOK | Data Use: ZDR "with all providers" under Privacy Mode; "Even if you use your API key, your requests will still go through our backend!" | BYOK or connected subscription: "your use may be governed by your own agreement with that third party"; user must make sure "the provider's terms allow you to use that subscription or plan through Capy". |
| Competing models | Terms 1.5(v): no use "to develop or train a model that is competitive with the Service" | AUP: no use "to build or train a substantially similar or competing AI software engineering platform" |
| Retention | "only for as long as necessary"; no periods | "as long as reasonably necessary"; deleted data "can be restored. On request, we permanently delete it within 30 days." Docs: machine asleep 30 days is deleted. |
| Account deletion | Security page: "You can delete your account at any time from the Settings dashboard" | Docs: "Delete account in Settings, Profile removes your sign-in and revokes your API keys. Your threads stay in their organization." |
| Subprocessors | Published at trust.cursor.com/subprocessors (not readable by fetch) | Full public table with change log and RSS |
| Liability cap | Greater of 6 months' fees or $100; "NO LIABILITY WHATSOEVER" for Beta Services | Greater of 12 months' fees for the service giving rise to the claim, or $100 |
| Law / disputes | Texas law; courts in Wichita or Tarrant County; class waiver; no arbitration | California law; San Francisco courts; 30-day informal step; binding individual JAMS arbitration; class waiver |
| Changes | Notice by "updating the date at the top"; effective on posting; continued use = acceptance | Notice by date update, in-product posting, email "or another reasonable method"; effective on posting; continued use = acceptance |

## Quotes by topic

### Minimum age and minors

Cursor Terms s.2: "You must be at least the age of majority in your
jurisdiction (e.g., 18 years old in the United States) or 18 years old,
whichever is higher, to use the Service. By agreeing to these Terms, you
represent and warrant to us that: (a) you are at least 18 years old or the age
of majority in your jurisdiction, whichever is higher; ..."

Cursor Privacy: "Anysphere does not knowingly collect information from or
direct any of our Service or content to children under the age of 18. If we
learn or have reason to suspect that a user is under the age of 18, we will
investigate and, if appropriate, delete the personal data and/or the account."

Capy Terms: "You must be at least 18 years old, or the age of majority in your
jurisdiction if higher, to use the Services. The Services are intended for
professional software development and business use, not for children."

Capy Privacy, "Children": "The Services are not directed to children under 18.
We do not knowingly collect personal information from children under 18. If you
believe a child has provided personal information to us, contact
support@capy.ai."

COPPA / under-13 language: not found in either.

### Acceptance

Cursor Terms preamble: "By using the Service, you agree to these Terms
including our Acceptable Use Policy."

Capy Terms: "By creating an account, clicking to accept these Terms, using the
Services, executing an order form that references these Terms, or allowing a
user to access the Services on your behalf, you agree to these Terms."

### Training and data use

Cursor Terms 1.3: "ANYSPHERE WILL NOT USE CONTENT TO TRAIN, OR ALLOW ANY THIRD
PARTY TO TRAIN, ANY AI MODELS, UNLESS YOU'VE EXPLICITLY AGREED TO THE USE OF
CONTENT FOR TRAINING."

Cursor Terms 1.2: "Inputs and Suggestions are collectively 'Content'."

Cursor Privacy: "We do not use Inputs or Suggestions to train our models, or
permit third parties to use them for training, unless: (1) they are flagged for
security review ..., (2) you explicitly report them to us (for example, as
Feedback), or (3) you've explicitly agreed to their use for such training
purposes."

Cursor Data Use: "If you enable 'Privacy Mode' in Cursor's settings: Customer
Data will not be used for training by Cursor. Cursor maintains zero data
retention (ZDR) agreements with all providers, and AI model providers will not
store or train on your data." ... "If you choose to turn off 'Privacy Mode': we
may use and store codebase data, prompts, editor actions, code snippets, and
other code data and actions to improve our AI features and train our models.
Some of our inference providers may temporarily access and store model inputs
and outputs to improve our inference performance; this data is deleted after
use."

Cursor Security: "Privacy Mode can be enabled in settings or by a team or
enterprise admin. Privacy Mode is available to anyone (free or Pro). New team
members inherit the team's Privacy Mode settings. When enabled, we will not
train on your data."

Privacy Mode default for individual accounts: not found on the fetched pages.
(Older ytimesy notes said it is on by default only for Enterprise teams; not
re-verified here.) Treating Privacy Mode off as "explicitly agreed" is
Cursor's own reading; the Terms and Data Use page are worded differently.

Capy Terms (stated twice) and Privacy: "Capy does not use non-public Customer
Content to train models that Capy develops or controls unless you explicitly
opt in or otherwise agree in writing."

Capy docs: "Model training | Capy doesn't use your non-public code, messages,
files, or other content to train models that Capy develops or controls, unless
you opt in or agree to it in writing."

Neither company excludes AI-generated output from training data. ytimesy's
rule (never use model replies or model-generated code) is stricter than both.

### Third-party model providers, subscriptions, ZDR

Cursor AUP: "When you access a third-party AI model through the Service, the
applicable Model Provider's acceptable use policy also applies."

Cursor Data Use: "Even if you use your API key, your requests will still go
through our backend! That's where we do our final prompt building."

Capy Terms: "When you bring your own model key, connect an external
subscription, use a customer-directed integration, ... your use may be
governed by your own agreement with that third party, and their privacy,
retention, abuse-monitoring, and data-use practices may apply."

Capy Terms: "If you connect a model subscription or plan, such as a Claude Pro
or Max subscription from Anthropic (including through Claude Code), a ChatGPT
or Codex plan from OpenAI, GitHub Copilot, or SuperGrok, you are responsible
for making sure that the provider's terms allow you to use that subscription or
plan through Capy. We are not responsible if a provider restricts, suspends, or
terminates your account, or charges you additional fees, because of your use
of that subscription or plan through the Services."

Capy docs: "On your own API key or subscription, requests go under your
agreement, including any zero data retention terms in it." "Zero data
retention | Available by agreement for Capy's own storage on Enterprise plans."

Capy Subprocessors: "When you use BYOK, external subscriptions,
customer-provided model credentials, or customer-directed model providers,
that provider may process data under your own agreement with that provider
rather than as Capy's subprocessor."

### Content and output ownership, licence

Cursor Terms 5.3: "You retain all of your right, title, and interest that you
have in Inputs, and Anysphere hereby assigns to you all of our right, title,
and interest if any in and to any Suggestions."

Cursor Terms 1.2: "We may use Content to provide the Service, comply with
applicable law, enforce our terms and policies, and keep the Service safe."

Cursor Terms 1.4: Suggestions "may be similar to or the same as Suggestions
provided to other customers".

Capy Terms: "As between you and Capy, you retain all rights in your Customer
Content. You grant us a limited, worldwide, non-exclusive license to access,
host, copy, transmit, display, transform, analyze, and otherwise process
Customer Content solely as needed to: ..."

Capy Terms: "you own Output generated specifically for you from your Customer
Content. We assign to you any right, title, and interest we may have in such
Output". "Output may not be unique".

### Acceptable use (selected)

Cursor Terms 1.5: no "(v) use the Service or any Suggestions to develop or
train a model that is competitive with the Service, or engage in model
extraction or theft attacks; (vi) probe, scan or attempt to penetrate the
Service; (vii) provide to any third party the results of any benchmark tests
of the Service, unless you include all necessary information for others to
replicate the tests; (viii) harvest, scrape, or extract data from the Service".
Also (x): no HIPAA, PCI or GLBA-regulated data.

Cursor AUP adds: "Jailbreaking, adversarial prompting, or prompt injection";
"Accessing the Service through automated or non-human means, whether through
a bot, script, or otherwise"; "We report suspected child sexual abuse material
to the National Center for Missing and Exploited Children."

Capy AUP: "mine cryptocurrency or run workloads unrelated to software
development and testing; use Capy VMs as a proxy, VPN, relay, crawler farm,
file host, CDN, production server, production worker, spam sender, or
persistent hosting platform"; "create multiple accounts ... to bypass limits";
"use credentials, sessions, API keys, or model subscriptions that belong to
someone else without authorization, or share a personal subscription in a way
its provider's terms do not allow"; "use the Services or Output to build or
train a substantially similar or competing AI software engineering platform,
except to the extent this restriction is prohibited by law".

Capy AUP, security research: "You may not conduct security testing against
Capy systems ... unless you have explicit authorization." Reports to
security@capy.ai.

### Retention and deletion

Cursor Privacy: "Anysphere retains your personal data only for as long as
necessary to operate the Service effectively and to support legitimate
business needs such as legal compliance, safety, dispute resolution, and
enforcement of our agreements." No periods given.

Cursor Security: "You can delete your account at any time from the Settings
dashboard".

Cursor Terms s.9: "We also may terminate your account if it has been inactive
for over a year and you do not have a paid account. If we do, we will provide
you with advance notice."

Capy Privacy: "Data you delete in the Services can be restored. On request, we
permanently delete it within 30 days. Deletion may not immediately remove data
from encrypted backups, archival logs, legal holds, billing records, ..."

Capy docs: "Capy deletes a machine asleep for 30 days, with everything you
didn't push or save to Drive." "Delete account ... removes your sign-in and
revokes your API keys. Your threads stay in their organization."

### Subprocessors, transfers, rights

Cursor Privacy: subprocessor list at "trust.cursor.com/subprocessors" (only
where Anysphere is a processor). Transfers: "we only transfer data in
accordance with legally valid transfer mechanisms". Rights: access, delete,
correct, transfer, object, restrict, withdraw consent, complain; requests to
hi@cursor.com; appeal by the same address. Sale of data: not found.

Capy Subprocessors page lists core vendors (AWS, Cloudflare, Vercel,
PlanetScale, ClickHouse, Upstash, Hatchet, Latitude.sh, Backblaze,
turbopuffer, Revyl, Grafana, Clerk, Stripe, Autumn, Customer.io, Pylon, Ashby,
Slack), model providers, customer-directed integrations, and marketing tools,
with a dated change log and an RSS feed.

Capy Privacy: transfers rely on "Standard Contractual Clauses, the UK
International Data Transfer Addendum, adequacy decisions, data processing
agreements". Separate GDPR legal-bases section and a US state-law table. "We
do not sell personal information. We do not share personal information for
cross-context behavioral advertising."

### Liability, warranty, indemnity, law, termination, changes

Cursor 15.2: "LIMITED TO THE GREATER OF: (A) THE AMOUNT YOU HAVE PAID TO
ANYSPHERE FOR ACCESS TO AND USE OF THE SERVICE IN THE SIX (6) MONTHS ..." or
"(B) $100". Beta (1.6): "ANYSPHERE SHALL HAVE NO LIABILITY WHATSOEVER ARISING
OUT OF OR IN CONNECTION WITH BETA SERVICES - USE AT YOUR OWN RISK."

Cursor 14: "THE SERVICE AND SUGGESTIONS ARE PROVIDED 'AS IS' AND ON AN 'AS
AVAILABLE' BASIS". 13: user defends and indemnifies the Anysphere Entities.

Cursor 16.1: Texas law; "exclusively in the federal or state courts located in
Wichita County or Tarrant County, Texas". 16.2: claims "ONLY ON AN INDIVIDUAL
BASIS". Arbitration: not found.

Cursor 8: "If we make any material modifications, we will notify you by
updating the date at the top of these Terms ... your continued accessing or
use of the Service will serve as confirmation of your acceptance".

Capy liability: "THE GREATER OF: (A) THE AMOUNTS YOU PAID TO US FOR THE
SERVICES GIVING RISE TO THE CLAIM DURING THE 12 MONTHS BEFORE THE EVENT ...; OR
(B) USD $100."

Capy free and beta: "provided 'as is,' without service-level commitments,
warranties, indemnities, or support obligations."

Capy disputes: 30 days informal; "binding arbitration on an individual basis
... administered by JAMS"; California law; San Francisco courts.

Capy changes: "we will provide notice by updating the date on this page,
posting in the Services, sending email, or using another reasonable method.
... changes become effective when posted. Your continued use ... means you
accept the updated Terms."

## What ytimesy takes from this

- Age 18 (or age of majority if higher), with Cursor's "if we learn ...
  close the account and delete the data" step. Both peers match on 18.
- Sign-in-wrap acceptance, like Capy's "By creating an account".
- Training: ytimesy is opt-out (on by default, shown at onboarding), unlike
  both peers' written opt-in rule. This is the largest difference from the
  benchmark and needs counsel review, especially for EU/UK users (consent must
  be a clear affirmative act). ytimesy is stricter on one point: model output
  is never training data.
- Subscription clause modelled on Capy: the user must check their provider
  allows use through ytimesy; we are not responsible for provider action.
- Public subprocessor table with a change note, modelled on Capy.
- Liability: greater of 12 months' fees or $100 (Capy); during a free beta
  this is effectively $100.
