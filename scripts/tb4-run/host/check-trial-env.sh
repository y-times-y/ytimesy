#!/bin/bash
# Proves a host can start a trial exactly as run-trial.sh does (run it as root after deploying
# the frozen repo, bundle, run.env and credentials): the trial user, the env from run.env, and
# the same sudo line. Imports the bridge agent, finds the AWS profile file and the bundle, and
# reaches Docker. No model call. Prints TRIAL-ENV-OK or the first failure.
set -uo pipefail
set -a; . /opt/tb4/run.env; set +a
cd /opt/tb4/ytimesy
sudo -u ubuntu -E env PYTHONPATH=/opt/tb4/ytimesy HOME=/home/ubuntu bash -c '
  set -e
  /home/ubuntu/.local/share/uv/tools/harbor/bin/python -c "import evals.harbor_v2.agent" || { echo "FAIL: cannot import evals.harbor_v2.agent"; exit 1; }
  [ -r "$HOME/.aws/credentials" ] && [ "$(stat -c %a "$HOME/.aws/credentials")" = 600 ] || { echo "FAIL: ~/.aws/credentials missing or not 0600"; exit 1; }
  [ -r "${YTIMESY_BRIDGE_BUNDLE:?}" ] || { echo "FAIL: bridge bundle missing"; exit 1; }
  docker info >/dev/null 2>&1 || { echo "FAIL: trial user cannot reach Docker"; exit 1; }
  echo "TRIAL-ENV-OK commit=$YTIMESY_HARNESS_COMMIT bundle=$(sha256sum "$YTIMESY_BRIDGE_BUNDLE" | cut -c1-16)"
'
