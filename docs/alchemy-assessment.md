# Alchemy (IaC) for the AWS box fleet and deploys: assessment (2026-11-24)

> **Superseded by the owner's decision the same day:** adopt Alchemy for all
> infrastructure. See [infrastructure-as-code.md](infrastructure-as-code.md). The two
> gaps below (`vpc_networks`, disk size) are patched locally in `infra/alchemy/patches/`,
> and the proof of concept became `infra/alchemy/aws.run.ts`.

Assessment only. Nothing was applied, and no AWS or Cloudflare resource was
created or changed. The live AWS state below comes from read-only `Describe*`
calls and `DryRun` requests made with this chat's AWS key.

## Are we using Alchemy (or any IaC tool)?

**No.** Nothing in `package.json`, the lockfile, `scripts/`, `infra/` or `docs/`
mentions Alchemy, Terraform, Pulumi, SST, CDK or CloudFormation. The only hit is
a made-up sentence inside a memory-eval fixture
(`scripts/memory-eval/long-history.ts`: "Infrastructure is managed with
Terraform in infra/"). It does not describe the repo.

How each piece of infrastructure is created and updated today:

| Piece | Created by | Updated by |
|---|---|---|
| Workers (web, edge executor, realtime, pr-repair, probes) | `wrangler deploy` with `wrangler.*.jsonc` | `scripts/deploy-production-from-secret.ts` → `deploy-production.ts` → `wrangler deploy --secrets-file` (one version per Worker, `production-deploy-steps.ts`) |
| Durable Objects (5 classes on the edge, 1 on realtime) | `migrations` in the wrangler files | the same wrangler deploy |
| Hyperdrive (production and development configs) | outside the repo (dashboard or CLI). No script creates one | ids are placeholders in git. Since 2026-11-23 (`963eb348`) the deploy reads the real ids from the live Workers' bindings (`production-identifiers.ts`). Before that it used a hand-made private patch, `~/.ytimesy-private/production-overlay.patch` (`a40559d6`, 2026-11-18) |
| R2 (`ytimesy-checkpoints-production`) | outside the repo | no binding: reached over the S3 API with keys kept as secrets |
| KV, Queues, D1 | none used | — |
| Workflows | pr-repair only (`wrangler.pr-repair.jsonc`) | its own dev deploy script |
| DNS | `custom_domain: true` routes (`ytimesy.com`, `edge.ytimesy.com`); wrangler creates the records | wrangler deploy |
| Worker secrets | `.secrets/production.env`, rebuilt from an account secret at deploy time; some secrets are derived | `wrangler deploy --secrets-file` |
| Postgres | Supabase (dashboard) | `scripts/db-migrate.ts` |
| Turn box fleet (us-east-1) | `infra/turn-box/fleet.py` (boto3, **run by hand**): security group, launch template, Auto Scaling group | re-running `fleet.py` (new template version plus instance refresh). Eight instance refreshes ran between 2026-11-21 and 11-23 |
| IAM role and instance profile `ytimesy-box` | **by hand**: no script in the repo creates them | by hand |
| Box program | `scripts/publish-turn-box.ts` uploads to R2, **run by hand** | boxes upgrade themselves to the newly published program once their running turns finish (`d8ee9f38`). `deploy-production.ts` does **not** publish it |
| CloudWatch | log group `/ytimesy/box` (14 days), created by the agent on the box | none. There are **no alarms** and **no scaling policies** |
| Claude runner boxes and Codex proxy (us-east-2) | `infra/claude-runner-box/provision.py`, single `RunInstances`, no instance profile | a manual volume-swap procedure (`docs/claude-code-placement.md`) |

### Checking the claims Y² was told

| Claim | Verdict |
|---|---|
| Deploys with wrangler and its own scripts, no IaC | **True** |
| Boxes are replaced and the box program is published manually | **True.** `fleet.py` and `publish-turn-box.ts` are run by hand, and the production deploy does not call them |
| The AWS key cannot create machines | **Out of date.** This chat's key (IAM user `ytimesy-box`) passes `DryRun` for RunInstances (including with the `ytimesy-box` instance profile), TerminateInstances, CreateLaunchTemplate and CreateSecurityGroup. It is denied IAM reads, CloudFormation, S3, Lambda and DynamoDB. The earlier key (`ytimesy_prod_for_codex`, 2026-11-16) never had RunInstances proven, which is probably where the claim came from |
| No autoscaling group yet | **False.** The `ytimesy-turn-box` group was created on 2026-11-21 (min 2, max 6, 2 in service, template version 2). It has a fixed size: no scaling policy and no alarms |
| The overlay patch was replaced by reading ids from the live Cloudflare account | **True** (`a40559d6` → `963eb348`) |

## What Alchemy is today (sources at the end)

- **Version.** Alchemy v2 is an Effect-based rewrite (`alchemy` plus
  `@alchemy.run/aws` and other packages). npm `latest` is `2.0.0-beta.87`
  (2026-11-12), under Apache-2.0. **It is still a beta**, and it needs
  **Effect 4** as a peer dependency, while this app pins Effect 3.22. It must
  therefore live in its own package, not in the app.
- **How it calls AWS.** It calls the service APIs directly (`@distilled.cloud/aws`),
  not through CloudFormation, so the key's CloudFormation denial does not block
  it. (A separate `CloudControl` module exists and would need
  `cloudformation:*Resource`.)
- **AWS resources this fleet needs (checked in the beta.87 source).**
  `IAM.Role`, `IAM.InstanceProfile`, `EC2.SecurityGroup`, `EC2.Vpc.lookup`,
  `AutoScaling.LaunchTemplate` (raw `userData` and an existing
  `instanceProfileName` pass through unchanged when no `main` is set),
  `AutoScaling.AutoScalingGroup`, `AutoScaling.ScalingPolicy` (target
  tracking), `AutoScaling.LifecycleHook`, `Logs.LogGroup`, `CloudWatch.Alarm`,
  `CloudWatch.Dashboard` and `SNS.Topic`.
- **Gaps for this fleet (beta.87).**
  - `LaunchTemplate` has **no `blockDeviceMappings`**, so the 20 GB gp3 root
    disk cannot be expressed (the image default is 8 GB).
  - `AutoScalingGroup` cannot enable group metrics collection.
  - `AutoScalingGroup` never starts an instance refresh. That is fine here:
    program updates need none.
- **Cloudflare resources.** `Worker`, Durable Objects (also shared across
  Workers), `Hyperdrive.Connection`, R2 (including presigned URLs), KV, Queues,
  domains and DNS, custom domains and routes, Secrets Store, and secrets and env.
- **State.** Local `.alchemy/` by default. Remote options:
  - `Cloudflare.state()`: a Worker plus a Durable Object, with an encryption key
    in Secrets Store.
  - `AWS.state()`: a DynamoDB table `alchemy-state` plus an S3 overflow bucket,
    with optional KMS.
  - Postgres, GCP, or a custom store.

  Locking is documented only for Postgres. In CI a missing store fails the run:
  `alchemy state bootstrap` creates it first.
- **Secrets.** `alchemy.secret` values are encrypted with `ALCHEMY_PASSWORD`.
  Credentials come from profiles (`~/.alchemy/profiles.json`) or environment
  variables in CI.
- **Environments.** Stages (`--stage prod`, `pr-123`, default `live_$USER`)
  are isolated, with their own state. Generated physical names include the
  stage; names you set explicitly do not.
- **Adopting existing resources.**
  - With no state, the engine reads the cloud resource. If it is "owned" (it
    carries the `alchemy::stack/stage/id` tags), it is adopted silently.
    Otherwise the deploy fails unless you pass `--adopt` (or `adopt(true)`),
    which applies to the whole stack.
  - Per resource, in the source: `IAM.Role` gates adoption properly.
    `AutoScalingGroup` adopts **silently** and converges config and tags.
    `LaunchTemplate` **refuses** an untagged existing template even with
    `--adopt` (`LaunchTemplateConflict`).
  - A force-deleted group kills its instances (`ForceDelete: true`) if the
    declaration is removed or renamed. `RemovalPolicy.protect()` prevents that.
- **Known rough edges.** Issue #2604: a failed existence check of
  `Cloudflare.state()` can make the bootstrap overwrite the live store's
  secrets. PR #1399 changed how entries encrypted under another key are read.
  The state store is where beta bugs have hurt.

**Not verified.**
- I did not run `alchemy plan` against the account: the key cannot read IAM,
  or create the DynamoDB state.
- So I could not see the live `ytimesy-box` role's policies. Alchemy would
  converge the role to exactly the declared managed policies and could detach
  any extra ones.
- I did not test adoption of a security group or log group.
- The docs pages for LaunchTemplate and adoption are thin. The resource details
  above come from reading the beta.87 source, not from an end-to-end run.
- I could not confirm how stable the API is between betas.

## Why did AWS take so long, and would Alchemy have made it fast?

The decision to move turns to AWS was made on 2026-11-15. Claude Code was live
on boxes by 2026-11-22, and the deploy-safety fixes landed on 2026-11-23:
about **nine days**. Since 2026-11-15, 65 commits mention boxes, with about
41k inserted lines. Of the files those commits touched, about 400 are in
`src/server`, about 110 in `src/domain` and **10 in `infra/turn-box`**. The
whole infrastructure part (`fleet.py`, `bootstrap.sh`, `start.mjs`,
`sigv4.mjs`, the publish script) is about 600 lines, written mostly on
2026-11-21.

Where the time went, from the commits and `docs/turn-runner-boxes.md`:

| Work | Examples | Would IaC have shortened it? |
|---|---|---|
| Harness and box protocol: running `runApiTurn` off the Durable Object through "ports" | stages 1, 2a, 2b, 3. Every product tool, MCP, memory, git, canvas, Y² and helpers through edge ports (`cec44172`, `66a1cbd0`, `6a4bd91f`, `8e1f558c`, `12ea31b5`) | **No.** This is application code |
| No secrets on a box: a thin client of the edge, grants, redaction | 2026-11-15 decision; Codex and Grok without credentials on the box (`54d71405`) | **No.** Security design |
| Leases, hand-offs and coordination | `2ff5518d`, `8016bd8a`, `273c953f`, `560d6fc9` | **No** |
| Checkpoints, history size, gzip | `7bcd3ec0`, `acdb0d9f`, `a6ba9009` | **No** |
| Model failover on boxes | `cdc203bf` | **No** |
| Claude Code moved onto boxes, with the MCP relay through hibernatable sockets | `ef2b6c6f`, `c3fb0cd2`, `5794f7c3` | **No** |
| Box identity: a 24-hour identity expired and caused an outage, then renewal and STS self-enrollment | `1572438f`, `3f265536`, `638595d4` | **Mostly no.** Enrollment is application code. IaC would have made "launch template plus group plus role" a declared thing, but `fleet.py` did that in one commit |
| Packaging the box program: QuickJS wasm inlined, the process staying alive, an unminified build | `a0a09f41`, `e7d424a3`, `6f13227f` | **No** |
| Deploys cutting running turns | `d8ee9f38`, `a624b4c7`, `bd31f186` | **No** |
| AWS permissions: the old key could not prove RunInstances or SSM, so updates were hand-made volume swaps (2026-11-10 to 11-16, Claude runner boxes) | `docs/claude-code-placement.md` | **Partly.** IaC needs the same permissions. The help would have come from deciding the permission set up front, not from the tool |
| Hand steps: the IAM role, running `fleet.py`, running the publish, the identifier overlay | — | **Yes.** This is what IaC is for. In days, though, it was a small share |

**Short answer.** Alchemy would have saved hours, not days. The slow part was
moving a stateful agent loop out of a Durable Object safely:
- no secrets on the box,
- leases,
- checkpoints,
- failover,
- Claude's MCP relay,
- deploys that do not cut turns.

No IaC tool writes that. Alchemy would have made the fleet reproducible from
day one, put the role and alarms in code, and removed the "did someone publish
the program?" step.

## Recommendation

**Do not adopt Alchemy now.** Revisit it when v2 leaves beta, `LaunchTemplate`
supports `blockDeviceMappings`, or a second fleet or stage (a dev fleet) is
needed. Reasons:
- The fleet is small and already scripted.
- v2 is a beta with Effect 4 (a second Effect major in the repo).
- It has two concrete gaps for this fleet.
- The real risks today are cheaper to fix in the existing scripts.

**Do now, without any new tool (about half a day):**

1. **Publish the box program in every production deploy.** Have
   `deploy-production.ts` call `publish-turn-box.ts` after the edge deploy, so
   the program never drifts from the edge API it talks to.
2. **Alarms and scaling in `fleet.py`:**
   - `PutMetricAlarm` on in-service boxes below 1 (after
     `EnableMetricsCollection`) and on log-reported failures, with an SNS or
     webhook action.
   - A target-tracking policy (CPU 60%), or desired capacity driven by the
     edge's queue depth.
3. **Put the IAM role in code.** Add the `ytimesy-box` role, its trust policy
   and `CloudWatchAgentServerPolicy` to `fleet.py` (or a sibling script), so a
   fresh account can be rebuilt.
4. **Log rotation on the box** (`/var/log/ytimesy-turn-box.log` has none).

**If you still want Alchemy** (a pilot for the AWS fleet only; leave the
Cloudflare side alone):
- Effort: about 1 to 2 days, plus whatever beta breakage turns up.
- Cost: the tool is free, and DynamoDB state costs cents a month.
- The shape is in `infra/alchemy/aws.run.ts` (type-checked against
  beta.87, never applied).

Migration without downtime:

1. Grant the permissions listed below. Run `alchemy state bootstrap --backend aws`.
2. Read the live role's attached and inline policies, and copy them into the
   declaration exactly (otherwise convergence detaches them).
3. Use a **new** launch template name (`ytimesy-turn-box-alchemy`), because
   the existing one cannot be adopted. Or keep it with
   `LaunchTemplate.lookup` until block devices are supported.
4. Wrap the role, the instance profile and the group in
   `RemovalPolicy.protect()`, and the security group and log group in
   `retain()`.
5. Run `alchemy plan --stage prod --adopt`. Check that it shows *update* (not
   *replace* or *delete*) for the group, role, profile and security group.
6. Run `alchemy deploy --stage prod --adopt`. The group switches to the new
   template, and running boxes keep running. New boxes use it only when the
   group replaces one.
7. To move existing boxes, start an instance refresh by hand, at MinHealthy
   50%. Running turns move to another box after 45 s. Or simply let the boxes
   cycle. Then delete the old template by hand.
8. Run `deploy` from the production deploy script after the edge deploy, and
   retire `fleet.py`.

**Leave the Cloudflare side alone.** Moving five Workers, their Durable
Object migrations, Hyperdrive, custom domains and secrets off wrangler, onto a
beta, would gain little. The overlay problem is already solved, and a
mistaken Durable Object migration or Worker replacement would hit every
running chat.

**AWS permissions you would grant** (to a deploy role, ideally assumed by CI
through OIDC rather than an IAM user key):
- `ec2:Describe*`, `ec2:CreateLaunchTemplate`, `ec2:CreateLaunchTemplateVersion`,
  `ec2:ModifyLaunchTemplate`, `ec2:DeleteLaunchTemplate`, `ec2:CreateTags`,
  `ec2:DeleteTags`, `ec2:CreateSecurityGroup`,
  `ec2:Authorize/RevokeSecurityGroupIngress/Egress`.
- `autoscaling:Describe*`, `CreateAutoScalingGroup`, `UpdateAutoScalingGroup`,
  `CreateOrUpdateTags`, `DeleteTags`, `PutScalingPolicy`, `DeletePolicy`,
  `EnableMetricsCollection`, `StartInstanceRefresh`.
- `iam:GetRole`, `CreateRole`, `UpdateAssumeRolePolicy`, `TagRole`,
  `List(Attached)RolePolicies`, `Attach/DetachRolePolicy`,
  `GetInstanceProfile`, `CreateInstanceProfile`, `AddRoleToInstanceProfile`,
  `TagInstanceProfile`, and `iam:PassRole` on `role/ytimesy-box` only.
- `logs:DescribeLogGroups`, `CreateLogGroup`, `PutRetentionPolicy`,
  `TagResource`.
- `cloudwatch:PutMetricAlarm`, `DescribeAlarms`, `DeleteAlarms`,
  `TagResource`. Plus `sns:*` on one topic, if you use SNS.
- State: `dynamodb:*` on `table/alchemy-state`, and `s3:*` on its overflow
  bucket (or `Cloudflare.state()` with a Cloudflare token for Workers and
  Secrets Store).

The scripts in "Do now" need the same EC2, Auto Scaling, CloudWatch and IAM
subset, minus the state store.

**Compared with AWS CDK and Terraform.**
- **CDK** goes through CloudFormation. This key is denied CloudFormation, and
  CDK needs `cdk bootstrap` (an S3 bucket plus IAM roles). Its import of
  existing resources (`cdk import`) is clunkier. It is mature but heavier.
- **Terraform or OpenTofu** has the most complete and stable AWS coverage:
  `block_device_mappings`, metrics collection and `instance_refresh` blocks.
  It adopts cleanly with `import {}` blocks and `plan`, and keeps state in S3
  with native locking. Its costs: HCL instead of TypeScript, and a separate
  binary.
- For this fleet alone, **Terraform is the safer choice today** if you want
  IaC. Alchemy wins only if you later want one TypeScript program across AWS
  and Cloudflare, and are willing to ride the beta.

## Sources

- Alchemy home and docs index: https://alchemy.run/ , https://alchemy.run/llms.txt
- EC2: https://alchemy.run/aws/compute/ec2
- LaunchTemplate and Auto Scaling: https://alchemy.run/providers/aws/autoscaling/launchtemplate/
- IAM: https://alchemy.run/aws/iam
- CloudWatch: https://alchemy.run/aws/observability/cloudwatch
- Hyperdrive: https://alchemy.run/cloudflare/data/hyperdrive
- State stores: https://alchemy.run/state-store
- Stages: https://alchemy.run/environments/stages
- Adoption: https://alchemy.run/cli/adopting-resources
- Cloudflare CLI and state bootstrap: https://alchemy.run/cli/cloudflare/
- v1 state docs (for comparison): https://v1.alchemy.run/concepts/state
- AutoScalingGroup PR #2817: https://github.com/alchemy-run/alchemy/pull/2817
- Metadata options PR #2426: https://github.com/alchemy-run/alchemy/pull/2426
- State store issue #2604: https://github.com/alchemy-run/alchemy/issues/2604
- State store PR #1399: https://github.com/alchemy-run/alchemy/pull/1399
- npm: https://www.npmjs.com/package/alchemy (2.0.0-beta.87); package source
  read from `@alchemy.run/aws@2.0.0-beta.87` (`src/AutoScaling/*.ts`,
  `src/EC2/hosted.ts`, `src/IAM/Role.ts`, `src/EC2/SecurityGroup.ts`).