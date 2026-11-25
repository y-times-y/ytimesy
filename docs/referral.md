# Referral

A personal link (`/?ref=r-xxxxxxxx`) lets a user invite a friend. When the friend
signs up and finishes a first task, both get a fresh usage window. The
reward applies to the platform's own included cloud usage windows only, never to
a plan or key the user connected.

## Flow

1. The page records the code in the `yt_ref` cookie (30 days) before it removes
   `ref` from the address bar (`captureReferralCode`). It is set under Do Not
   Track and in opt-in regions too: it is the visitor's own request to credit
   the inviter and carries only the code.
2. The cookie survives the email-code, GitHub and Google sign-in. At account
   creation (`accountCreated`) the server re-validates it and stores a
   `referral` row (`attributeReferral`). Nothing is rewarded here.
3. The maintenance tick (`settle-referrals`, every 5 minutes) moves a referral
   to `pending` once the referred account has a verified address and a
   completed turn (`usage_turn_counted`), and decides it 60 minutes later.
4. A grant writes two `referral_reward` rows (referred, referrer) and settles
   the referral in one transaction under the usage budget lock. A reward is a
   credit: it restarts the exhausted windows when the account is next held
   back (or at once, if it already is), audited as a `window_reset`.

## Rules

- The referred account earns at most one reward, ever. The referrer earns one
  per qualified referral, at most 3 in a rolling 30 days and 12 in total; past
  the cap the referred account is still rewarded.
- Blocked: same account, same normalised address (case, `+tag`, Gmail dots),
  an address already used in another referral, a shared linked sign-in account.
- Held (never rewarded): the sign-up network and browser match one of the
  referrer's recent sessions; more than 3 sign-ups from one network in a day.
- A referrer's referrals are decided at most 2 a day.
- Stored: only HMACs of the normalised address and of the network prefix
  (/24 or /48) with the browser family.

## Operating

- Kill switch: `YTIMESY_REFERRAL_DISABLED=1`, or Settings → Referral →
  "Pause referral" (operators). Off means no attribution, no grants and no
  prompts; pending referrals are kept.
- Counts by status and reason are in the same panel (and the `Referral pass.`
  log line).
- What cannot be prevented: a person with another mail provider, network,
  device and sign-in account looks like a real friend. The caps and the delay
  bound what that gains, and the kill switch stops it.
