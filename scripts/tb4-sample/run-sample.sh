#!/bin/bash
# On the sample host, as ubuntu, under systemd-run (sample.sh start), so an ssh drop
# does not stop it: run-sample.sh <run-id> <commit> [task ...]
# One Harbor job per task (one trial, full agent timeout), all in parallel, plus the
# spend watcher. Without task arguments it runs every task in ~/stage/tasks.txt.
# A task's job dir that already exists is never rerun (rerun: sample.sh rerun).
set -uo pipefail
run="$1"; commit="$2"; shift 2
[[ "$run" =~ ^[A-Za-z0-9._-]+$ && "$commit" =~ ^[0-9a-f]{40}$ ]] || exit 2
[ "$(cat ~/repo/.harness-commit 2>/dev/null)" = "$commit" ] || { echo "~/repo is not $commit; run host-setup.sh" >&2; exit 2; }
export PATH=$HOME/.local/bin:$PATH
R=$HOME/runs/$run
mkdir -p "$R/jobs" "$R/logs"
if [ $# -gt 0 ]; then tasks=("$@"); else mapfile -t tasks < ~/stage/tasks.txt; fi
set -a; . ~/stage/run.env; set +a
export PYTHONPATH=$HOME/repo YTIMESY_REPO=$HOME/repo
export YTIMESY_HARBOR_SPEND_LEDGER=$R/ledger.jsonl
export YTIMESY_HARBOR_PREFLIGHT=$HOME/stage/preflight.json
export YTIMESY_BRIDGE_BUNDLE=$HOME/bridge.mjs
export YTIMESY_HARNESS_COMMIT=$commit YTIMESY_HARNESS_VERSION=tb4-sample-${commit:0:12}
cd ~/repo
cp ~/stage/config-check.json "$R/" 2>/dev/null
{ echo "{\"run\":\"$run\",\"commit\":\"$commit\",\"bundleSha256\":\"$(cat ~/bridge.sha256)\",\"startedAt\":\"$(date -u +%FT%TZ)\",\"host\":\"$(t=$(curl -sf -m 2 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token) && curl -sf -m 2 -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/instance-type || echo unknown)\",\"nproc\":$(nproc)}"; } > "$R/run-$(date -u +%Y%m%dT%H%M%S).json"
python3 ~/stage/spendwatch.py "$R" "${TB4S_HARD_USD:-40}" > "$R/logs/spendwatch.log" 2>&1 &
watcher=$!
pids=()
for task in "${tasks[@]}"; do
  [[ "$task" =~ ^[a-z0-9-]+(@r[0-9])?$ ]] || { echo "bad task $task" >&2; continue; }
  name=${task/@/-}; base=${task%@*}
  [ -e "$R/jobs/$name" ] && { echo "$name already ran; skipping" >&2; continue; }
  [ -e "$R/ledger.jsonl.stop" ] && { echo "stop file present; not starting $name" >&2; break; }
  YTIMESY_TRANSPORT_LOG=$R/logs/$name.transport.log \
  uvx --from harbor==0.24.0 harbor run -d terminal-bench/terminal-bench@4.0.0 \
    -i "terminal-bench/$base" -a evals.harbor_v2.agent:YtimesyHarborV2Agent -e docker \
    -k 1 -n 1 --max-retries 0 --agent-timeout-multiplier 1.0 --agent-setup-timeout-multiplier 3 \
    --jobs-dir "$R/jobs" --job-name "$name" > "$R/logs/$name.harbor.log" 2>&1 &
  pids+=($!)
  echo "$(date -u +%FT%TZ) started $name pid $!"
  sleep 20   # stagger image pulls and agent installs
done
for p in "${pids[@]}"; do wait "$p"; echo "$(date -u +%FT%TZ) pid $p exit $?"; done
kill "$watcher" 2>/dev/null
python3 ~/stage/spendwatch.py "$R" "${TB4S_HARD_USD:-40}" --once >> "$R/logs/spendwatch.log" 2>&1
date -u +%FT%TZ > "$R/DONE"
