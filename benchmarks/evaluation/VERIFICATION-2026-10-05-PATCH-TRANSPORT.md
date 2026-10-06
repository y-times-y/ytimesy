# Paired development diagnostic: subscription patch compatibility

Run: `df91fbc6-675d-4fc3-9b1e-d2691f3f80f1`, October 5, 2026.
This is one known development task, not a holdout or a general benchmark win.

## Conditions

- Both arms used GPT-6.1 Sol, Medium reasoning, Fast mode off, the same prompt,
  and clean source commit `ffb92b004ab9901b25df6d6850949455b6513b44`.
- Native Codex CLI was pinned to `0.159.2`, using the same subscription backend.
- ytimesy used the current dirty development runtime; selected runtime hashes,
  including memory, tool discovery and model-profile modules, were checked
  against the disposable worker and saved with the private evidence.
- Three independent configuration validators and their tests were requested.
  The hash-pinned protected verifier was not supplied to either agent.
- Both had a 600-second turn deadline. Native request/token limits are not
  enforceable by this bridge, and its network/sandbox differs from ytimesy's.
- Publication was disabled. No rescue prompts or runtime changes occurred
  during the paired run. The user approved $5 maximum disposable Freestyle
  spending and existing Codex subscription usage, not persistent hosting.

## Result

| Arm | Outcome | Recorded time | Token evidence |
| --- | --- | --- | --- |
| ytimesy | Failed before implementation | 93,303 ms | 289,878 observed tokens; 13 request reservations |
| Native Codex | Passed 562 protected assertions | 214,951 ms | 391,475 input; 348,416 cached input; 7,407 output |

The failed arm's lower time or tokens are **not** an efficiency improvement.
Native timing includes 2,513 ms of protected grading; shared preparation was
8,669 ms and is reported separately. Request reservations are not proof of
13 successful model generations. No numerical code-quality advantage can be
claimed when ytimesy produced no implementation.

The leader created three independent builders together. All three failed their
first model call with HTTP 400, before attaching execution VMs. The lead
finished without claiming successful implementation. A separate minimal live
transport probe, using the same subscription model and SDK built-in patch tool,
reproduced HTTP 400 with this exact backend detail:

```text
Unsupported tool type: apply_patch
```

The SDK's built-in Responses patch tool therefore must not be assumed compatible
with the Codex subscription endpoint. The current job enables it for every
subscription writer; read-only leaders do not receive it. A compatible function
editing tool is the next fix. It was not changed during this diagnostic and no
successful rerun is claimed.

## Code inspection and limitations

Independent inspection of the native patch found exactly the six allowed files,
pure typed validators, ordered validation, prototype-safe environment insertion,
fresh service objects, and focused tests for malformed input and non-mutation.
No dependencies, routes, test bypasses, or protected-verifier access were added.
The native event record also reports 122 author-written tests, typechecking,
format/lint checks and build success; these are captured agent execution records,
separate from our independent 562-assertion protected grade.

Native connector startup emitted authorization errors, although inference and
grading completed. This diagnostic is not a perfectly matched sandbox/network
comparison or a model-wide quality ranking.

## Cost and cleanup

Before the run the configured Freestyle account had zero VMs and snapshots and
the database had no queued/running turns. After cleanup it again had zero VMs
and zero snapshots. The disposable projects were removed and the exact temporary
$5 admission grant was withdrawn; prior policies were not altered. No persistent
worker remains running.

Compute is approximately $0.09 at the published gross per-second rates, before
allowances/credits. This is an estimate from resource sizes and bounded lifetimes,
not a reconciled invoice. Storage and transfer were not independently reconciled.
Rates: [Freestyle pricing](https://www.freestyle.sh/pricing).

Private protocols, events, patches, runtime hashes, and cleanup evidence remain
under `.ytimesy/paired-memory-ReOn5B/`; they are intentionally not committed.
