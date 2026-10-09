# Public native Codex Terminal-Bench results

Verified 2026-10-07 by read-only requests to the [public Harbor job](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7) and its per-trial metadata. No inference, environments, grading, or resources were started. No hidden task tests, solutions, trajectories, or patches were read.

The native run succeeded on session-window-debug **4/5**, wal-recovery-ordering **5/5**, and nextjs-performance **4/5**. These are repeated trials in one public run, not a paired experiment against ytimesy.

## Recorded configuration

The [job](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7) records Terminal-Bench 4.0.0, agent `codex`, version `0.159.0`, provider/model `openai/gpt-6.1-sol`, reasoning effort `max`, five planned trials per task, and 64 concurrent trials. It ran on 2026-09-30. The dataset digest is `sha256:39d9f44b40420cde8fdcc087579c0d72a7e14fa3656d603c3f0d22fb35e27732`.

The [trial configuration](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/524fbff7-08a1-5003-9f33-335374dbd2ae) records direct credentials, Modal through Harbor's SupervisorEnvironment, separate verification, timeout multiplier 1, no extra instructions, no skills, and no MCP servers. Agent/verifier/setup/build-specific timeout multipliers are null. Neither this public job configuration nor trial lock exposes absolute time limits, output-token caps, context-window caps, CPU count, or memory size; those limits are **not verified here**. These records confirm the Codex adapter/version but do not independently verify the exact installed executable or invocation flags.

## Means across five scored trials per task

Means include reward-zero trials. Whole-trial duration is `finished_at - started_at`; agent duration uses `agent_execution` timestamps. Timing is rounded to milliseconds. Cache percentage is sum(cache_tokens)/sum(input_tokens), weighted across the five trials. Token counts are Harbor's reported cumulative request counts; cached input is already part of input and must not be added again. These totals are not unique-context size.

| Task | Success | Mean whole trial, seconds | Mean agent execution, seconds | Successful whole-trial range, seconds | Mean input | Mean output | Mean input + output | Cached input | Mean cost |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| session-window-debug | 4/5 | 867.9328 | 541.4374 | 797.667–977.882 | 346248.6 | 28196.6 | 374445.2 | 85.5917% | $0.4359087 |
| wal-recovery-ordering | 5/5 | 1034.1106 | 601.4836 | 826.963–1276.254 | 486990.6 | 32882.8 | 519873.4 | 88.4900% | $0.5115365 |
| nextjs-performance | 4/5 | 2659.4930 | 2524.8072 | 1854.585–3934.054 | 5169792.6 | 107154.2 | 5276946.8 | 96.3162% | $2.0432141 |

Whole-trial timing includes installation/setup and verification: for example, [session e2d28cd8](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/524fbff7-08a1-5003-9f33-335374dbd2ae) took 797.667 seconds overall but 448.128 seconds of agent execution. Comparing whole-trial timing with an agent-only time budget would be misleading.

## Per-trial evidence

Each linked trial page supplies its reward, execution timestamps, task digest, and recorded runtime. Input/output/cache/cost values come from the job's public Trials listing, retrieved through its read-only `fetchJobTrials` server action.

| Task | Trial | Reward | Whole seconds | Agent seconds | Input | Output | Cache | Cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| session-window-debug | [e2d28cd8](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/524fbff7-08a1-5003-9f33-335374dbd2ae) | 1 | 797.667 | 448.128 | 366627 | 24092 | 320173 | $0.3886303 |
| session-window-debug | [1deba976](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/ec4e0b0c-4296-53bf-b93d-986936644cea) | 1 | 900.269 | 575.298 | 350033 | 29088 | 299433 | $0.4468813 |
| session-window-debug | [60de77c7](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/fcdc838b-547f-51d2-9ba0-5fb80601cb4e) | 1 | 868.442 | 628.782 | 392631 | 31986 | 337959 | $0.4898939 |
| session-window-debug | [7db54950](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/6373d49f-e610-5fda-bf00-8cfedcdb233a) | 0 | 795.404 | 450.971 | 188160 | 22401 | 147057 | $0.3412012 |
| session-window-debug | [bd2bf104](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/1c91e1f0-053c-52ad-9761-f83e58981fe8) | 1 | 977.882 | 604.008 | 433792 | 33416 | 377178 | $0.5129368 |
| wal-recovery-ordering | [3cf68ca3](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/827802b1-2a2b-5c13-a395-8192e37ffcce) | 1 | 1070.923 | 546.863 | 628118 | 27870 | 577007 | $0.4635662 |
| wal-recovery-ordering | [c13b511d](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/f77f0db1-9779-59d0-94f6-a34060b3d253) | 1 | 1035.202 | 654.429 | 448317 | 35003 | 388683 | $0.5375073 |
| wal-recovery-ordering | [6ecccc76](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/0dab9dd1-5654-5f5a-af0e-6589b6f9fa69) | 1 | 826.963 | 467.986 | 422116 | 27215 | 372211 | $0.4336236 |
| wal-recovery-ordering | [09321ec8](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/699938e8-fa77-5fc5-8be1-61e71cf0bdd1) | 1 | 961.211 | 618.930 | 430312 | 35493 | 372603 | $0.5359868 |
| wal-recovery-ordering | [1882877b](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/7b5fb3cf-75f9-5632-a00d-b255c90312ca) | 1 | 1276.254 | 719.210 | 506090 | 38833 | 444186 | $0.5869986 |
| nextjs-performance | [c620e079](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/d7ab9037-f8b8-5a14-9e1d-aea3e36bdf39) | 1 | 3934.054 | 3811.737 | 8446491 | 144574 | 8074700 | $3.1796615 |
| nextjs-performance | [eb989093](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/8a70aa1a-348c-5273-bf04-59b8f57a41e0) | 0 | 2508.675 | 2349.479 | 5710377 | 110322 | 5553908 | $2.0473353 |
| nextjs-performance | [e8f11f3f](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/b43a764d-e592-51d7-8fc0-c9b17077b8ef) | 1 | 2589.787 | 2475.444 | 3361922 | 104546 | 3215045 | $1.732321 |
| nextjs-performance | [205d129a](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/49101d83-7188-53f1-ad6d-1004a55d3c7d) | 1 | 2410.364 | 2285.895 | 4975543 | 100386 | 4820093 | $1.8718443 |
| nextjs-performance | [b809cf92](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/3a1e5231-fce2-5221-b3e1-e9913da9ff6e) | 1 | 1854.585 | 1701.481 | 3354630 | 75943 | 3232997 | $1.3849082 |

The [earlier WAL setup attempt](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/e746b17f-5a22-5b7d-bc0f-b565774a9a4a), for trial name `wal-recovery-ordering__3cf68ca3`, has `AgentSetupTimeoutError`, null reward/tokens/cost, and `is_scored=false`. Its later scored attempt succeeded. There are 16 API rows but 15 scored trials; the setup failure is excluded from the means and success denominator, not treated as a solver failure.

Task version digests, identical across the five scored trials for each task:

- session-window-debug: `sha256:f7e05e0d4c0e90d7050445fd158db514158272c50aafa1b2446ef3f68bd01182`.
- wal-recovery-ordering: `sha256:8eb700419711e0d5eba317b8f6dec41aa3411e03e320e82b8da8070974ff3aae`.
- nextjs-performance: `sha256:81f8315fb984f91208c45b4ac153c8801d07d3beec5eb0f0d3fa9d49b6588fdd`.

## Retrieval and comparison limits

The public HTML contains server-rendered job and initial-trial JSON. To avoid the first-100-row limitation, the frontend's [public JavaScript](https://hub.harborframework.com/_next/static/immutable/chunks/3rz-3703htvu_.js) identifies the read-only `fetchJobTrials` server action. A POST to the job URL with `Next-Action: 4023c930c2cb3f4fccd1c27c58a774f132c359725d`, JSON body `[{jobId: "...", page: 1, tasks: ["terminal-bench/session-window-debug", "terminal-bench/wal-recovery-ordering", "terminal-bench/nextjs-performance"]}]`, and `Accept: text/x-component` returned all 16 rows, `total_pages: 1`. This build-specific action identifier can change. Trial detail metadata was obtained from the linked public HTML pages without opening their trajectories.

This run establishes that native Codex solved all three task types with the recorded configuration. It does not establish the cause of any private ytimesy failure or a performance advantage: task digests, agent version, reasoning effort, environment, effective time budgets, and scoring must be aligned before making that causal comparison. The two public reward-zero trials have no exception in the returned listing; their solution failure details were not inspected.
