# Referral links

Use one link per platform. The site records the first `ref` (and any `utm_*`)
a visitor arrives with, keeps it for 90 days, saves it on the account at
sign-up and removes it from the address bar right after the page loads.

| Platform | Home page | Blog post |
| --- | --- | --- |
| X | https://ytimesy.com/?ref=x | https://ytimesy.com/blog/harness-1-0?ref=x |
| LinkedIn | https://ytimesy.com/?ref=linkedin | https://ytimesy.com/blog/harness-1-0?ref=linkedin |
| Hacker News | https://ytimesy.com/?ref=hackernews | https://ytimesy.com/blog/harness-1-0?ref=hackernews |
| Reddit | https://ytimesy.com/?ref=reddit | https://ytimesy.com/blog/harness-1-0?ref=reddit |
| Product Hunt | https://ytimesy.com/?ref=producthunt | https://ytimesy.com/blog/harness-1-0?ref=producthunt |
| Discord | https://ytimesy.com/?ref=discord | https://ytimesy.com/blog/harness-1-0?ref=discord |
| Email | https://ytimesy.com/?ref=email | https://ytimesy.com/blog/harness-1-0?ref=email |
| GitHub | https://ytimesy.com/?ref=github | https://ytimesy.com/blog/harness-1-0?ref=github |
| YouTube | https://ytimesy.com/?ref=youtube | https://ytimesy.com/blog/harness-1-0?ref=youtube |
| Newsletter | https://ytimesy.com/?ref=newsletter | https://ytimesy.com/blog/harness-1-0?ref=newsletter |

Rules for new tags: lower case, `a-z 0-9 _ -`, at most 32 characters; anything
else is dropped. To split one platform further, add `utm_campaign` or
`utm_content`, for example
`https://ytimesy.com/?ref=x&utm_campaign=launch&utm_content=thread`.

What is not counted: bots and link unfurlers, visitors with Do Not Track or
Global Privacy Control, and visitors in the EU, EEA, UK or Switzerland (no
cookie without consent there). A visitor who first came without a tag stays
untagged even if they later click a tagged link (first touch wins).

## Conversions in PostHog

Events (there is no `signed_up` event; `account_created` is the sign-up event
for email, GitHub and Google):

- `app_viewed`: every page view, with `initial_ref` and `initial_utm_source`
  from the first-touch cookie.
- `account_created`: sent once by the server at sign-up, with `initial_ref`,
  `initial_utm_*`, `initial_referrer_host` and `initial_landing_path`. The same
  values are set on the person with `$set_once`, so they never change.
- `turn_started`: a chat turn starting. Its first occurrence is the first chat
  (there is no separate first-chat event).

Funnel: Product analytics, New insight, Funnels.

1. Steps: `app_viewed`, then `account_created`, then `turn_started`.
2. Breakdown: event property `initial_ref`, attribution "First step". (Person
   property `initial_ref` works too, but only covers people who signed up.)
3. Conversion window: 14 days or more; filter `environment = production`.

Sign-ups per platform only: Trends, `account_created`, total count, breakdown by
`initial_ref`.

The database keeps the same first touch per account:

```sql
select ref, count(*) from user_attribution group by ref order by 2 desc;
```
