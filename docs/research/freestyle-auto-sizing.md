# Freestyle automatic workspace sizing

Verified against current official documentation on 2026-10-04 using `agent-browser read`. This is documentation research; no VM was created, resized, restarted, or billed during verification.

## Status: deferred

User decision on 2026-10-04: do not implement Auto mode now. Keep the current
fixed default and manual Small / Medium / Large / Ultra preferences.
This note records future work, not an enabled sizing policy.

When revisiting:

- Measure setup, build, test, browser, and service workloads rather than infer
  requirements from repository size alone. Record peak memory, free disk,
  sustained CPU pressure, execution duration, and failures.
- Choose initial resources using workload requirements and prior project
  measurements. Leave headroom for temporary install/build peaks; proposed
  starting sizes and thresholds remain unvalidated, not accepted defaults.
- Grow only the constrained resource, with sustained-pressure checks for CPU
  and RAM and proactive disk-space checks. Avoid upgrades on brief spikes or
  while merely waiting for remote model inference.
- Optimize successful completion time and total cost, not hourly price alone.
  Preserve a manual override and enforce account limits and admission budgets.
- Account for grow-only VMs and inherited snapshot sizes. Remember measured
  project needs without promising in-place downsizing.
- Validate live resizing, uncertain outcomes, process and desktop continuity,
  budget accounting, and representative workload performance before rollout.

## Resize contract

`vm.resize({ cpu, memory, storage })` accepts any subset of those resources. CPU, memory, and storage can only increase; moving to a smaller shape requires a new VM. Memory and storage arguments use **MiB**. Requested sizes remain subject to account limits. [VM lifecycle: resize](https://www.freestyle.sh/docs/vms/lifecycle#resize)

| Resource | Running VM | Paused or stopped VM |
| --- | --- | --- |
| CPU | Added live, without reboot | Applied on resume or next start |
| Memory | Added live, without reboot | Applied on resume or next start |
| Root disk | Grows in place while guest runs | Start the VM before growing disk |

These behaviors are documented; survival of this application's agent processes and desktop connections through a real resize remains untested. The docs do not specify resize latency, concurrent-resize arbitration, atomicity of a multi-resource resize, or whether a failed request can partially apply. Read back effective allocation before assuming a change succeeded. [VM lifecycle](https://www.freestyle.sh/docs/vms/lifecycle#resize)

## Cost and ceilings

Standard billing charges **allocated** vCPU and memory rather than measured guest utilization, metered per second. Published rates are **$0.04032/vCPU-hour**, **$0.0129/GiB-memory-hour**, and **$0.000086/GiB-storage-hour**. A paused VM bills storage only. Therefore growing a running VM raises its compute cost even if the extra allocation remains idle. CPU plus memory costs $0.13224/hour at 2 vCPU / 4 GiB, $0.26448/hour at 4 / 8, and $0.52896/hour at 8 / 16, before allowances, storage, transfer, and plan minimums. [Pricing and limits](https://www.freestyle.sh/docs/vms/pricing-and-limits#usage-pricing)

Monthly included usage applies to every plan: 200 vCPU-hours, 400 GiB-memory-hours, and 60,000 GiB-storage-hours. Free treats these as hard allowances; exhaustion pauses affected VMs until resumed after reset. Paid usage continues above allowances. Hobby has a $50/month minimum including $50 usage; Pro has $500 including $500 usage. These are usage credits, not additional surcharges. [Pricing and limits](https://www.freestyle.sh/docs/vms/pricing-and-limits)

| Standard plan | Max vCPU per VM | Max memory per VM | Max disk per VM |
| --- | --- | --- | --- |
| Free | 4 | 8 GiB | 32 GB |
| Hobby | 8 | 16 GiB | 64 GB |
| Pro | 32 | 64 GiB | 256 GB |

The pricing table labels disk ceilings **GB**, whereas resize parameters use **MiB** and storage billing uses **GiB**. Verify effective API limits and unit interpretation before sizing at a boundary. VMs start at their snapshot's size; the default snapshot is 4 vCPU / 8 GiB / 32 GB, so smaller starting shapes require an appropriate smaller snapshot. [Pricing and limits](https://www.freestyle.sh/docs/vms/pricing-and-limits#default-vm-specs)

Per-VM caps are only one gate. Concurrent-VM limits and total resource budgets also apply. CPU/memory budgets count running, starting, or pausing VMs; the disk budget counts every saved VM. A limit violation rejects the request and identifies the limit. Pausing releases compute budget but keeps disk allocation. [Plan limits and total budgets](https://www.freestyle.sh/docs/vms/pricing-and-limits#total-provisioned-resources)

**Account caveat:** the original Extra Large preset of 32 GiB memory / 128 GiB disk exceeded published standard Hobby per-VM ceilings. It was replaced on 2026-10-04 with Ultra (8 vCPU / 16 GiB memory / 64 GiB disk), retaining the saved `extra-large` identifier. Verify effective disk units and available account capacity before claiming live provisioning at the maximum; inherited larger snapshots cannot shrink to fit. Enterprise permits custom limits and optional active-CPU or node-based billing; sponsorship alone does not establish which contract applies. [Enterprise options](https://www.freestyle.sh/docs/vms/pricing-and-limits#enterprise-options)

## Implications for an automatic policy

The supported operation is bounded upward growth. Repeated growth cannot be undone on the same VM, so a policy needs an explicit starting shape, account-aware maximum, and cost budget. CPU, memory, and disk should be considered separately; a single saturated resource does not establish a need to increase all three. Thresholds and polling intervals are product decisions requiring workload measurements, not values supplied by Freestyle's documentation.

Before implementation, verify account entitlements and SDK behavior for limit errors and uncertain outcomes. Before claiming production readiness, run a controlled live resize with the actual workspace image and confirm effective allocation, active agent survival, desktop/terminal reconnection, disk expansion, and observed metering. None of those live checks was performed for this note.
