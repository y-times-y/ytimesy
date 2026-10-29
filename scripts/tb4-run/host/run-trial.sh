#!/bin/bash
# One TB4 trial on this host: run-trial.sh <task> <attempt-id>. Started by the
# controller with systemd-run (unit tb4-trial-<attempt-id>), so it survives an
# ssh drop or a controller restart. Writes /opt/tb4/jobs/<attempt-id>/.
set -uo pipefail
task="$1"; id="$2"
[[ "$task" =~ ^[a-z0-9-]+$ && "$id" =~ ^[A-Za-z0-9._-]+$ ]] || exit 2
job=/opt/tb4/jobs/$id
[ -e "$job" ] && { echo "attempt $id already exists; refusing to rerun it" >&2; exit 3; }
mkdir -p "$job" && chown ubuntu:ubuntu "$job"   # Harbor runs as ubuntu below and writes here
set -a; . /opt/tb4/run.env; set +a   # route, variant, caps, ledger, bundle (no secrets printed)
export YTIMESY_TRANSPORT_LOG="$job/transport.log" YTIMESY_HARBOR_SPEND_LEDGER=/opt/tb4/ledger.jsonl
# Per-task trial cap (Astra run: scripts/tb4-run/astra-trial-caps.json copied to
# /opt/tb4/trial-caps.json); the run.env cap applies to tasks not listed.
if [ -f /opt/tb4/trial-caps.json ]; then
  cap=$(jq -r --arg t "$task" '.[$t] // empty' /opt/tb4/trial-caps.json)
  [ -n "$cap" ] && export YTIMESY_HARBOR_TRIAL_USD_CAP="$cap"
fi
echo "trial cap: ${YTIMESY_HARBOR_TRIAL_USD_CAP:-unset}" > "$job/trial-cap.txt"
if nvidia-smi >/dev/null 2>&1; then
  # Scoring rule: the GPU model is asserted inside the trial's container before the
  # agent starts. Until the bridge does it in-container, record the host GPU here.
  nvidia-smi --query-gpu=name --format=csv,noheader > "$job/gpu-assert.txt"
fi
cd /opt/tb4/ytimesy
# sudo drops PYTHONPATH (and HOME here, under systemd-run): set both for the trial user so
# Harbor imports the bridge agent from the frozen repo and the AWS SDK finds ~/.aws.
exec sudo -u ubuntu -E env PYTHONPATH=/opt/tb4/ytimesy HOME=/home/ubuntu /home/ubuntu/.local/bin/harbor run -d terminal-bench/terminal-bench@4.0.0 \
  -i "terminal-bench/$task" -a evals.harbor_v2.agent:YtimesyHarborV2Agent -e docker \
  -k 1 -n 1 --jobs-dir /opt/tb4/jobs/"$id" --job-name "$id" > "$job/harbor.log" 2>&1
