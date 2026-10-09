# Public native Codex configuration — 2026-10-08

Read-only browser inspection of the public Harbor job and `session-window-debug__e2d28cd8` trial. This records configuration and displayed timing, not a controlled comparison of runtimes.

## Verified configuration

- The job Config specifies agent `codex`, version `0.159.0`, model `openai/gpt-6.1-sol`, and `reasoning_effort: "max"`. The trial Config and Lock repeat these values. [Job Config](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7), [Trial Config/Lock](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/524fbff7-08a1-5003-9f33-335374dbd2ae)
- Job and trial Config declare `credential_mode: "direct"` and the secret name `OPENAI_API_KEY`; Lock uses the placeholder `${OPENAI_API_KEY}`. No secret value was exposed or inspected. Job Config declares five attempts, 64 concurrent trials, and `static_outbound_ip: true`. [Job Config](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7), [Trial Config/Lock](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/524fbff7-08a1-5003-9f33-335374dbd2ae)
- Trial Lock records agent `skills: []`, `mcp_servers: []`, `resume_trajectory: false`, and `extra_allowed_hosts: []`; trial Config records empty extra instructions. These are explicit additional configuration fields. The displayed trajectory nevertheless contains four bundled system skills, so the empty skills array does not establish that the native runtime had no skills. [Trial Lock/Config/Trajectory](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/524fbff7-08a1-5003-9f33-335374dbd2ae)
- Lock records environment type `modal` with import path `hosted_harbor.isolation.environment:SupervisorEnvironment`, empty environment kwargs, and `stream: false`. These are Harbor environment settings; they do not establish whether model responses streamed internally. [Trial Lock](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/524fbff7-08a1-5003-9f33-335374dbd2ae)

## Verified displayed timing and usage

The trial page reports completed status and reward `1.00`, agent execution **7m 28s**, agent setup **5m 3s**, environment setup **9s**, verifier **15s**, and total **13m 17s**. Usage shown is output **24,092**, prompt **46,454**, cached **320,173**, total **390,719** tokens, and cost **$0.3886**. These are Harbor's displayed aggregates. [Trial summary](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/524fbff7-08a1-5003-9f33-335374dbd2ae)

The trajectory UI exposes step elapsed times and deltas, including `+1m 1s` at elapsed `1m 25s`, and `+2m 21s` at elapsed `3m 46s`. Those intervals alone do not isolate model request latency, time to first token, token throughput, or tool execution time. [Trial Trajectory](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/524fbff7-08a1-5003-9f33-335374dbd2ae)

## Unknowns and limits

Neither inspected Config nor Lock exposes a Fast-mode flag or a `service_tier` value. Absence from these public fields does **not** prove Fast mode was disabled, nor does it establish backend scheduling or serving throughput. The public configuration establishes matching model and reasoning labels; it is insufficient to claim equivalent serving conditions. [Job Config](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7), [Trial Config/Lock](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/524fbff7-08a1-5003-9f33-335374dbd2ae)

The Agent tab lists `codex.txt`, `trajectory.json`, and a native rollout JSONL. The raw log fetch did not finish during this inspection, so this note makes no claims about its request-level instrumentation or exact native invocation flags. No hidden grader, canonical solution, VM, or model inference was used. [Trial Agent tab](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/524fbff7-08a1-5003-9f33-335374dbd2ae)
