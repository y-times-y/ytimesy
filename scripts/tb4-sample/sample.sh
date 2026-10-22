#!/bin/bash
# TB4 paired sample vs Codex (docs/tb4-sample-gate.md): 12 CPU tasks x 1 trial, our newest
# harness on Bedrock, one m7i.16xlarge in us-east-1, all trials in parallel.
#
#   sample.sh prepare <commit>            local only: check the commit, archive it, stage files
#   sample.sh launch                      one m7i.16xlarge (paid EC2 starts here)
#   sample.sh setup <commit>              copy stage + Bedrock creds, install, bundle, config check
#   sample.sh start <run-id> <commit>     12 trials in parallel under systemd (paid Bedrock)
#   sample.sh status <run-id>             per-task progress and live spend
#   sample.sh rerun <run-id> <commit> <task>   one infra rerun (job <task>-r2)
#   sample.sh fetch <run-id>              rsync results to $STATE/results/<run-id>
#   sample.sh analyze <run-id> <commit>   per-task table, paired comparison, gate verdict
#   sample.sh cleanup                     terminate the host, delete volume, SG, key
#   sample.sh ssh [cmd]
#
# State (key, SG, instance, staged files, results) lives in $TB4S_STATE, never in the repo.
# Secrets are copied, never printed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${TB4S_STATE:-/private/tmp/claude-501/-Users-hetpatel-Documents-ChatGPT-cloud/9b852ab4-1c67-4bf3-8800-e4d8d401cdab/scratchpad/sample}"
PY="${TB4S_PY:-/private/tmp/claude-501/-Users-hetpatel-Documents-ChatGPT-cloud/9b852ab4-1c67-4bf3-8800-e4d8d401cdab/scratchpad/awsenv/bin/python}"
SOURCE_REPO="${TB4S_SOURCE_REPO:-/path/to/cloud}"
PREFLIGHT="${TB4S_PREFLIGHT:-$STATE/preflight.json}"   # 2026-10-21 oracle/nop preflight (tb4-preflight 77e1b5c)
VARIANT='lead=fusion,review=on,checkerMode=single,rigor=on,codeMode=primary,roleModels.checker=bedrock:openai.gpt-6.1-sol,roleModels.writer=bedrock:openai.gpt-6-luna,roleModels.classifier=bedrock:openai.gpt-6-luna@low'
TRIAL_USD=8
HARD_USD=40
mkdir -p "$STATE"

aws() { "$PY" -I "$HERE/aws.py" "$STATE" "$@"; }
ip() { "$PY" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["ip"])' "$STATE/state.json"; }
SSH_OPTS=(-i "$STATE/key.pem" -o UserKnownHostsFile="$STATE/known_hosts" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ConnectTimeout=10)
remote() { aws ipsync; ssh "${SSH_OPTS[@]}" "ubuntu@$(ip)" "$@"; }
copy() { aws ipsync; scp "${SSH_OPTS[@]}" "$@"; }
need_commit() { [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "give the frozen commit as a full 40-hex sha" >&2; exit 2; }; }
tasks() { "$PY" -I -c 'import json,sys; [print(t["task"]) for t in json.load(open(sys.argv[1]))["tasks"]]' "$HERE/tasks.json"; }

cmd="${1:-}"; shift || true
case "$cmd" in
prepare)
  commit="${1:-}"; need_commit "$commit"
  git -C "$SOURCE_REPO" cat-file -e "$commit^{commit}" || { echo "commit $commit not in $SOURCE_REPO" >&2; exit 1; }
  for f in evals/harbor_v2/agent.py evals/harbor_v2/bridge.ts evals/harbor_v2/config.ts evals/harbor_v2/spend.ts benchmarks/harbor/ytimesy_agent.py pnpm-lock.yaml; do
    git -C "$SOURCE_REPO" cat-file -e "$commit:$f" 2>/dev/null || { echo "commit $commit lacks $f (harbor-bridge-v2 not merged?)" >&2; exit 1; }
  done
  for key in codeMode rigor checkerMode roleModels lead; do
    git -C "$SOURCE_REPO" show "$commit:evals/harbor_v2/config.ts" | grep -q "\"$key\"" || { echo "bridge config at $commit lacks variant key $key" >&2; exit 1; }
  done
  [ -s "$PREFLIGHT" ] || { echo "no preflight file at $PREFLIGHT" >&2; exit 1; }
  "$PY" -I - "$HERE/tasks.json" "$PREFLIGHT" <<'PY'
import json, sys
sample = json.load(open(sys.argv[1])); pf = json.load(open(sys.argv[2]))
bad = [t["task"] for t in sample["tasks"] if not pf["tasks"].get(t["task"], {}).get("passed")]
if bad: sys.exit(f"tasks without a passing preflight: {bad}")
# Host CPU budget (scripts/tb4-run/lib.ts fitsCpu): sum(task cpus + 1) <= vCPU - 2.
need = sum(t["cpus"] + 1 for t in sample["tasks"])
if need > 64 - 2: sys.exit(f"CPU budget {need} > 62 on m7i.16xlarge")
print(f"preflight ok for {len(sample['tasks'])} tasks; CPU budget {need} <= 62")
PY
  rm -rf "$STATE/stage" && mkdir -p "$STATE/stage" "$STATE/secret" && chmod 700 "$STATE/secret"
  git -C "$SOURCE_REPO" archive --format=tar.gz -o "$STATE/stage/repo.tgz" "$commit"
  tasks > "$STATE/stage/tasks.txt"
  cp "$PREFLIGHT" "$STATE/stage/preflight.json"
  cp "$HERE/spendwatch.py" "$HERE/host-setup.sh" "$HERE/run-sample.sh" "$STATE/stage/"
  n=$(wc -l < "$STATE/stage/tasks.txt" | tr -d ' ')
  cat > "$STATE/stage/run.env" <<EOF
YTIMESY_HARBOR_ROUTE=bedrock
YTIMESY_HARBOR_APPROVED=bedrock
YTIMESY_HARBOR_AWS_PROFILE=harbor
YTIMESY_HARBOR_MODEL=openai.gpt-6.1-sol
YTIMESY_HARBOR_EFFORT=max
YTIMESY_HARBOR_VARIANT='$VARIANT'
YTIMESY_HARBOR_TRIAL_USD_CAP=$TRIAL_USD
# The ledger reserves each trial's whole cap at start: $n parallel trials need $n x \$$TRIAL_USD.
# The sample's real total (\$$HARD_USD) is enforced by spendwatch.py.
YTIMESY_HARBOR_TOTAL_USD_CAP=$((n * TRIAL_USD))
YTIMESY_HARBOR_REQUEST_LIMIT=1000
TB4S_HARD_USD=$HARD_USD
EOF
  # Only the [harbor] profile goes to the host; nothing is printed.
  "$PY" -I - "$HOME/.aws/credentials" "$STATE/secret/credentials" <<'PY'
import configparser, os, sys
src = configparser.RawConfigParser(); src.read(sys.argv[1])
if not src.has_section("harbor"): sys.exit("no [harbor] profile in ~/.aws/credentials")
out = configparser.RawConfigParser(); out.add_section("harbor")
for k, v in src.items("harbor"): out.set("harbor", k, v)
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: out.write(f)
print("credentials staged (harbor profile only)")
PY
  echo "$commit" > "$STATE/stage/commit"
  echo "prepared $commit: $(du -h "$STATE/stage/repo.tgz" | cut -f1) archive, $n tasks"
  ;;
launch) aws launch "$@" ;;
setup)
  commit="${1:-}"; need_commit "$commit"
  [ "$(cat "$STATE/stage/commit")" = "$commit" ] || { echo "stage is for $(cat "$STATE/stage/commit"); run prepare $commit" >&2; exit 1; }
  for i in $(seq 1 30); do remote true 2>/dev/null && break; sleep 10; done
  remote 'mkdir -p ~/stage ~/.aws && chmod 700 ~/.aws'
  copy "$STATE"/stage/* "ubuntu@$(ip):stage/"
  copy "$STATE/secret/credentials" "ubuntu@$(ip):.aws/credentials"
  remote 'chmod 600 ~/.aws/credentials && chmod +x ~/stage/*.sh'
  remote "bash ~/stage/host-setup.sh $commit"
  ;;
start)
  run="${1:-}"; commit="${2:-}"; need_commit "$commit"
  [[ "$run" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad run id" >&2; exit 2; }
  remote "sudo systemd-run --unit tb4s-$run --uid ubuntu --gid ubuntu --setenv=HOME=/home/ubuntu --property=KillMode=process --working-directory=/home/ubuntu bash /home/ubuntu/stage/run-sample.sh $run $commit"
  echo "started tb4s-$run; watch: sample.sh status $run"
  ;;
rerun)
  run="${1:-}"; commit="${2:-}"; task="${3:-}"; need_commit "$commit"
  [[ "$task" =~ ^[a-z0-9-]+$ ]] || { echo "bad task" >&2; exit 2; }
  remote "sudo systemd-run --unit tb4s-$run-$task-r2 --uid ubuntu --gid ubuntu --setenv=HOME=/home/ubuntu --property=KillMode=process --working-directory=/home/ubuntu bash /home/ubuntu/stage/run-sample.sh $run $commit $task@r2"
  ;;
status)
  run="${1:-}"
  remote "R=~/runs/$run; systemctl is-active tb4s-$run || true; cat \$R/spend.json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(\"spend\", d[\"totalUsd\"], \"of\", d[\"hardUsd\"], \"at\", d[\"at\"])' || true;
    for j in \$R/jobs/*/; do n=\$(basename \$j); r=\$(cat \$j/*__*/result.json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get(\"verifier_result\") or {}).get(\"rewards\"), (d.get(\"exception_info\") or {}).get(\"exception_type\"))' 2>/dev/null || echo running); echo \"\$n \$r\"; done;
    ls \$R/DONE \$R/ABORTED 2>/dev/null; uptime"
  ;;
fetch)
  run="${1:-}"; mkdir -p "$STATE/results"
  aws ipsync
  rsync -az -e "ssh ${SSH_OPTS[*]}" "ubuntu@$(ip):runs/$run" "$STATE/results/"
  echo "fetched to $STATE/results/$run"
  ;;
analyze)
  run="${1:-}"; commit="${2:-}"; need_commit "$commit"
  python3 "$HERE/analyze.py" "$STATE/results/$run" --commit "$commit" --json "$STATE/results/$run/analysis.json"
  ;;
cleanup) aws cleanup ;;
ssh) remote "$@" ;;
*) sed -n 2,17p "$0"; exit 2 ;;
esac
