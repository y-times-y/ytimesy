#!/bin/bash
# One TB4 trial on this host: run-trial.sh <task> <attempt-id>. Started by the
# controller with systemd-run (unit tb4-trial-<attempt-id>), so it survives an
# ssh drop or a controller restart. Writes /opt/tb4/jobs/<attempt-id>/.
set -uo pipefail
task="$1"; id="$2"
[[ "$task" =~ ^[a-z0-9-]+$ && "$id" =~ ^[A-Za-z0-9._-]+$ ]] || exit 2
job=/opt/tb4/jobs/$id
[ -e "$job" ] && { echo "attempt $id already exists; refusing to rerun it" >&2; exit 3; }
mkdir -p "$job"
set -a; . /opt/tb4/run.env; set +a   # route, variant, caps, ledger, bundle (no secrets printed)
export YTIMESY_TRANSPORT_LOG="$job/transport.log" YTIMESY_HARBOR_SPEND_LEDGER=/opt/tb4/ledger.jsonl
if nvidia-smi >/dev/null 2>&1; then
  # Scoring rule: the GPU model is asserted inside the trial's container before the
  # agent starts. Until the bridge does it in-container, record the host GPU here.
  nvidia-smi --query-gpu=name --format=csv,noheader > "$job/gpu-assert.txt"
fi
cd /opt/tb4/ytimesy
exec sudo -u ubuntu -E /home/ubuntu/.local/bin/harbor run -d terminal-bench/terminal-bench@4.0.0 \
  -i "terminal-bench/$task" -a evals.harbor_v2.agent:YtimesyHarborV2Agent -e docker \
  -k 1 -n 1 --jobs-dir /opt/tb4/jobs/"$id" --job-name "$id" > "$job/harbor.log" 2>&1
