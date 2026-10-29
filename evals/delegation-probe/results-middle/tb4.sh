#!/bin/zsh
# usage: tb4.sh <round> <task>...   real runs stopped after 10 requests; helpers=write, middle rule
R=$1; shift
S=/private/tmp/claude-501/-Users-hetpatel-Documents-ChatGPT-cloud/9b852ab4-1c67-4bf3-8800-e4d8d401cdab/scratchpad/middle
cd /path/to/cloud-middle
D=$S/tb4/$R; mkdir -p $D
source $S/env.sh
export PYTHONPATH=$PWD YTIMESY_REPO=$PWD YTIMESY_HARBOR_PREFLIGHT=skip
export YTIMESY_HARBOR_TRIAL_USD_CAP=2.5 YTIMESY_HARBOR_REQUEST_LIMIT=10
export YTIMESY_HARBOR_VARIANT=codeMode=on,plan=on,helpers=write,fetch=on,search=function
export YTIMESY_HARNESS_COMMIT=$(git rev-parse --short HEAD)
run() { uvx --from harbor==0.24.0 harbor run -d terminal-bench/terminal-bench@4.0.0 -i terminal-bench/$1 \
  -a evals.harbor_v2.agent:YtimesyHarborV2Agent -e docker -k 1 -n 1 --jobs-dir $D/jobs --job-name t-$1 > $D/$1.log 2>&1; }
i=0
for task in "$@"; do run $task & i=$((i+1)); if (( i % 7 == 0 )); then wait; fi; done
wait
echo ALLDONE > $D/ALLDONE
