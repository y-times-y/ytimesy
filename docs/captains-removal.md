# Captains removed (2026-11-26)

Captains (additional Super agents per project) were built as step 1, deployed, then removed on the owner's decision before anyone used them. The design stays in the canvas "Artifacts and captains design", section B, for later.

- **Code:** reverted by one commit on top of main (8afdc7ee), never by rewriting history; deployed first.
- **Data:** the migration `20261126130000_captains.sql` stays in history (it was applied in production); `20261126140000_drop_captains.sql` drops the `captain` table, `project.leader_name` and the `captain` chat role, and deletes captain chats. Applied to production after the code was off (host `aws-0-us-east-2.pooler.supabase.com`).
- **What existed in production (read-only check before deleting):** 1 captain row, 1 captain chat, both the test account's; no other user; no project had a leader name.

Backup of the one row (no secrets):

| field | value |
|---|---|
| captain id | 91282064-4142-4c1e-9fc9-fe80e950395c |
| owner | ytimesy-test-account (test account) |
| project | ee68ea01-0b8b-47df-8e8a-38918b72d7f9 |
| chat | efdbc136-36d9-412f-bc42-b3b564ac06a9 (title "seo", 4 items, 1 turn) |
| name / label / colour / position | seo / content / #d97757 / 0 |
| role | 216 characters ("You own search visibility for this project. Audit titles, meta descriptions…") |
| created | 2026-11-26 01:48 UTC |

The inline artifacts feature (docs/artifacts.md) is separate and untouched.
