# Infrastructure as code (Alchemy)

Decision (2026-11-24, owner): all infrastructure is managed as code with
[Alchemy](https://alchemy.run) v2, in `infra/alchemy`. Before that it was
wrangler, scripts run by hand, and hand-made AWS resources. The background
and the trade-offs are in [alchemy-assessment.md](alchemy-assessment.md).

## Layout

| Stack | File | Stages | What it owns |
|---|---|---|---|
| `ytimesy-cloudflare` | `infra/alchemy/cloudflare.run.ts` | `development`, `production` | the edge executor and web Workers: code, secrets, Durable Objects, Hyperdrive (lookup), VPC egress, service, email, AI and memory bindings, crons, the edge's custom domain. Development also has the realtime Worker |
| `ytimesy-aws` | `infra/alchemy/aws.run.ts` | `production` | the turn box fleet: IAM role and instance profile `ytimesy-box`, security group, the `/ytimesy/box` log group, launch template, Auto Scaling group, CPU target tracking, alarms |

- **Package.** `infra/alchemy` is its own package with its own lockfile, so
  its two patches and the beta dependency stay apart from the app. The app
  moved to Effect 4 (`effect` 4.1.5, 2026-11-24, same version as Alchemy),
  but nothing in the app imports Alchemy, and the root `tsconfig.json`
  excludes the package. Install it with
  `pnpm --dir infra/alchemy install --ignore-workspace --frozen-lockfile`.
- **Patches.** `infra/alchemy/patches/` holds two small patches to
  `2.0.0-beta.87`, applied by pnpm:
  - the `vpc_network` Worker binding (`CODEX_EGRESS`). Without it Alchemy
    would turn the binding into a JSON variable, and Codex subscription
    traffic would break;
  - `blockDeviceMappings` on the launch template (the boxes' 20 GB gp3 disk).

  An Alchemy upgrade must re-create both patches, or drop them once
  upstream supports these.
- **State.** The Cloudflare state store (`Cloudflare.state()`): a Worker
  (`alchemy-state-store`) and a Durable Object in the account, encrypted at
  rest with a key in Secrets Store. It holds the Worker secrets the stack
  uploads, so it sits in the same trust boundary as the Workers.
- **Not in the stacks.** These are looked up, or stay outside:
  - Hyperdrive configs: looked up by name, because their origin password is
    write-only;
  - the R2 buckets;
  - Supabase (`scripts/db-migrate.ts`);
  - the public app route (gated by `YTIMESY_GO_LIVE` in the deploy script);
  - the Claude runner boxes and the Codex proxy in us-east-2;
  - the pr-repair and probe Workers;
  - DNS zones.

  Add them to a stack the same way (adopt, then protect) when they next
  change.

## How to change infrastructure

Only through `scripts/infra.ts`; never `alchemy deploy`, `wrangler deploy`
or the AWS console:

```sh
node --import tsx scripts/infra.ts plan   cloudflare --stage development --plan-only-local   # reads only
node --import tsx scripts/infra.ts deploy cloudflare --stage development
node --import tsx scripts/infra.ts plan   aws --stage production
node --import tsx scripts/infra.ts deploy aws --stage production --confirm-production
```

Production web and edge code still ship only through
`scripts/deploy-production-from-secret.ts`. With `YTIMESY_DEPLOY_ENGINE=alchemy`
it uploads through the Cloudflare stack, and it publishes the turn box
program after every successful smoke check.

### Why agents cannot easily break it

1. **The stack refuses to remove things.** Every stateful resource is
   `RemovalPolicy.protect()`: Workers, role, profile, security group and
   Auto Scaling group. A plan that would delete or replace one fails before
   anything is applied, including `alchemy destroy`.
2. **The runner checks the plan, too.** `scripts/infra.ts` applies only a plan
   that `scripts/infra-plan-guard.ts` accepts. It refuses:
   - any delete, replace, orphan or lost binding, whatever the protect
     policy says;
   - an adoption without `--adopt-existing`;
   - in production, creating a resource that already exists there (the
     symptom of a failed read).
3. **It refuses to adopt unless told.** With no state, Alchemy refuses to
   take over resources it did not create (`OwnedBySomeoneElse`).
4. **Stages are fixed.** A stack runs only as `development` or `production`,
   never Alchemy's per-user default stage. The AWS stack runs only as
   `production`.
5. **Production needs proof.** A production deploy needs
   `--confirm-production` and a checkout that contains `origin/main`.
6. **One deploy at a time.** A lock is held per stack and stage on the
   machine.
7. **Secrets set outside Alchemy are never deleted.** Alchemy deletes only
   secrets it uploaded earlier and no longer declares.
8. **Durable Objects are never deleted.** Undeclared namespaces are kept: the
   Worker upload declares every namespace Cloudflare reports, and is
   rejected rather than deleting one.

## Verified (2026-11-24, read-only, local state, nothing applied)

- **Development Cloudflare plan** (`--adopt`): Edge, Web and Realtime
  **adopted**, no declared property changes, nothing deleted or replaced.
  Without `--adopt` it is refused with `OwnedBySomeoneElse`.
- **Production Cloudflare plan** (production builds, `--adopt`): Edge and Web
  **adopted**. The guard passes.
- **Declared bindings match the live ones** on all five Workers: Durable
  Objects, Hyperdrive, `vpc_network`, service, email, AI, artifacts, plain
  variables, compatibility settings and placement.
- **The Hyperdrive lookup** resolves the right configs, with their origin
  password untouched.
- **The AWS plan** loads, authenticates and starts diffing, then stops at
  `iam:GetRole`: the AWS key cannot read IAM yet.
- **A plan finding.** A web `EXECUTOR` binding that pointed at the edge
  resource's output made the plan show the existing web Worker as `create`
  (its read waits for the edge). It now binds by script name, and the guard
  refuses a production `create` of `Edge`, `Web` or the fleet.

## Rollout (each step needs the owner's go)

1. **Permissions** (AWS, see below), and confirming that the deploy token may
   create the state store (a Worker plus a Secrets Store secret).
2. **Development:**
   `node --import tsx scripts/infra.ts deploy cloudflare --stage development --adopt-existing`.
   It bootstraps the state store and adopts the three development Workers,
   re-uploading their current code. Check:
   - `/health` on the edge;
   - the web loads;
   - a Codex chat (VPC egress) and an API chat both run.
3. **Production Cloudflare:** one deploy with
   `YTIMESY_DEPLOY_ENGINE=alchemy YTIMESY_INFRA_ADOPT=1`, from `origin/main`
   through `deploy-production-from-secret.ts`. Its smoke check and its
   wrangler rollback stay as they are.
4. **Production AWS:**
   `scripts/infra.ts deploy aws --stage production --confirm-production --adopt-existing`.
   The role, profile, security group and group are adopted. A new launch
   template `ytimesy-turn-box-alchemy` is created, the group switches to it,
   and alarms and CPU scaling are added. Running boxes keep running and
   move over as the group replaces them. Then delete the old
   `ytimesy-turn-box` template by hand, and `infra/turn-box/fleet.py`.
5. **Make Alchemy the default** (`deployEngine` in `deploy-production.ts`),
   delete the wrangler upload path and `production-identifiers.ts`'s
   Hyperdrive patching, and point `docs/turn-runner-boxes.md` at
   `aws.run.ts`.

### AWS permissions the deploy key needs

The current key (IAM user `ytimesy-box`) can already do the EC2 and Auto
Scaling writes. It is missing:
- IAM: `iam:GetRole`, `ListAttachedRolePolicies`, `ListRolePolicies`,
  `GetRolePolicy`, `ListRoleTags`, `TagRole`, `UntagRole`,
  `UpdateAssumeRolePolicy`, `UpdateRole`, `AttachRolePolicy`,
  `DetachRolePolicy`, `GetInstanceProfile`, `ListInstanceProfileTags`,
  `TagInstanceProfile`, `AddRoleToInstanceProfile`, and `iam:PassRole` on
  `role/ytimesy-box` only.
- Logs: `logs:DescribeLogGroups`, `PutRetentionPolicy`, `TagResource`,
  `ListTagsForResource`.
- CloudWatch: `cloudwatch:PutMetricAlarm`, `DescribeAlarms`, `TagResource`,
  `ListTagsForResource`.
- Auto Scaling: `autoscaling:PutScalingPolicy`, `DescribePolicies`.

(`Create*` IAM actions are needed only to rebuild a fresh account.) Before
step 4, read the live role's attached and inline policies. The stack
declares exactly `CloudWatchAgentServerPolicy`, and adoption would detach
anything else.

## Effect 4 in the app (2026-11-24)

The app moved from Effect 3.22 to 4.1.5. What changed, for the next reader:

- Renames: `Effect.either` is `Effect.result` (`Result`, with `_tag`
  `Success` or `Failure` and fields `success` and `failure`, replaces
  `Either` with `Left` and `Right`); `catchAll` is `catch`; `catchAllCause`
  is `catchCause`; `tapErrorCause` is `tapCause`; `Context.Tag` is
  `Context.Service<Self, Shape>()("key")`; `Schedule.intersect(recurs(n),
  spaced(d))` is `retry({ schedule: spaced(d), times: n })`.
- `Effect.runPromise` rejects with the failure itself (the squashed cause),
  no longer a `FiberFailure` wrapper. `readableServerError` reads a bare
  `Response`.
- `Effect.tryPromise(fn)` without `catch` fails with `UnknownError` (the
  original is its `cause`, not `error`), and its default text is "An error
  occurred in Effect.tryPromise". `failure-message.ts` and
  `subagent-start.ts` accept both texts, because stored failures can carry
  the old one.
- `@rigkit/*` (only `tests/rigkit-engine.test.ts`) keeps its own Effect 3
  through its own dependency; nothing passes Effect values across.
