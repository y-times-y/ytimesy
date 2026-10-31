#!/bin/bash
# One TB4 GPU trial on Daytona from the runner host: run-gpu-trial.sh <task> <attempt-id>.
# Started by the controller's GPU lane with systemd-run (unit tb4-trial-<attempt-id>), one
# at a time (docs/tb4-run-controller.md, "GPU lane on Daytona"). Writes /opt/tb4/jobs/<id>/
# like run-trial.sh, plus daytona-sandboxes.jsonl (sandbox lifetimes) and gpu-assert.txt.
#
# Needs on the runner: /opt/tb4/hd (venv with harbor[daytona]==0.24.0), /opt/tb4/daytona/
# (sitecustomize.py, daytona-ctl.py), /opt/tb4/daytona-key (0600), /opt/tb4/daytona-snapshots.json,
# /opt/tb4/run.env and the frozen tree at /opt/tb4/ytimesy.
set -uo pipefail
task="$1"; id="$2"
[[ "$task" =~ ^[a-z0-9-]+$ && "$id" =~ ^[A-Za-z0-9._-]+$ ]] || exit 2
job=/opt/tb4/jobs/$id
[ -e "$job" ] && { echo "attempt $id already exists; refusing to rerun it" >&2; exit 3; }
mkdir -p "$job" && chown ubuntu:ubuntu "$job"
set -a; . /opt/tb4/run.env; set +a   # route, variant, caps (no secrets printed)
export YTIMESY_TRANSPORT_LOG="$job/transport.log" \
  YTIMESY_HARBOR_SPEND_LEDGER=/opt/tb4/ledger-gpu-daytona.jsonl
if [ -f /opt/tb4/trial-caps.json ]; then
  cap=$(jq -r --arg t "$task" '.[$t] // empty' /opt/tb4/trial-caps.json)
  [ -n "$cap" ] && export YTIMESY_HARBOR_TRIAL_USD_CAP="$cap"
fi
echo "trial cap: ${YTIMESY_HARBOR_TRIAL_USD_CAP:-unset}" > "$job/trial-cap.txt"
# The Harbor patch (sitecustomize.py): pinned-image root snapshots, one GPU sandbox at a
# time, H100 asserted by nvidia-smi inside each GPU sandbox, sandbox lifetimes logged.
export YTIMESY_DAYTONA_SNAPSHOTS="$(jq -c . /opt/tb4/daytona-snapshots.json)" \
  YTIMESY_DAYTONA_ONE_GPU=1 \
  YTIMESY_DAYTONA_SANDBOX_LOG="$job/daytona-sandboxes.jsonl" \
  YTIMESY_GPU_ASSERT_FILE="$job/gpu-assert.txt" \
  YTIMESY_ATTEMPT_ID="$id"
DAYTONA_API_KEY="$(cat /opt/tb4/daytona-key)"; export DAYTONA_API_KEY
touch "$job/daytona-sandboxes.jsonl" "$job/gpu-assert.txt"
chown ubuntu:ubuntu "$job/daytona-sandboxes.jsonl" "$job/gpu-assert.txt"
cd /opt/tb4/ytimesy
# 15 h backstop over Harbor's own limits (fp8: agent 8 h + verifier 5 h + sandbox setup).
exec sudo -u ubuntu -E env PYTHONPATH=/opt/tb4/ytimesy:/opt/tb4/daytona HOME=/home/ubuntu \
  timeout 54000 /opt/tb4/hd/bin/harbor run -d terminal-bench/terminal-bench@4.0.0 \
  -i "terminal-bench/$task" -a evals.harbor_v2.agent:YtimesyHarborV2Agent -e daytona \
  -k 1 -n 1 --jobs-dir /opt/tb4/jobs/"$id" --job-name "$id" > "$job/harbor.log" 2>&1
