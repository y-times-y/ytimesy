#!/bin/bash
# On the sample host, as ubuntu: host-setup.sh <commit>. No model calls.
# Unpacks the frozen commit (git archive) to ~/repo, installs its dependencies, bundles
# the Harbor bridge, and parses the bridge config from ~/stage/run.env so a wrong
# variant, role model, effort or cap fails here instead of in 12 trials.
set -euo pipefail
commit="$1"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "commit must be a full 40-hex sha" >&2; exit 2; }
for i in $(seq 1 90); do [ -e /var/log/tb4s-setup.done ] && break; sleep 10; done
[ -e /var/log/tb4s-setup.done ] || { echo "user-data setup did not finish; see /var/log/tb4s-setup.log" >&2; exit 1; }
[ -s ~/.aws/credentials ] && [ "$(stat -c %a ~/.aws/credentials)" = 600 ] || { echo "~/.aws/credentials missing or not 0600" >&2; exit 1; }
rm -rf ~/repo && mkdir -p ~/repo && tar xzf ~/stage/repo.tgz -C ~/repo
echo "$commit" > ~/repo/.harness-commit
cd ~/repo
for f in evals/harbor_v2/agent.py evals/harbor_v2/bridge.ts evals/harbor_v2/config.ts benchmarks/harbor/ytimesy_agent.py; do
  [ -e "$f" ] || { echo "commit $commit lacks $f (is harbor-bridge-v2 merged?)" >&2; exit 1; }
done
npx -y pnpm@10.20.0 install --frozen-lockfile >~/stage/pnpm-install.log 2>&1 || { tail -20 ~/stage/pnpm-install.log; exit 1; }
npx esbuild evals/harbor_v2/bridge.ts --bundle --platform=node --format=esm --target=node22 \
  --outfile="$HOME/bridge.mjs" \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" >/dev/null
sha256sum ~/bridge.mjs | cut -d' ' -f1 > ~/bridge.sha256
set -a; . ~/stage/run.env; set +a
export YTIMESY_HARBOR_SPEND_LEDGER=/tmp/tb4s-config-check.jsonl
node --import tsx -e '
import("./evals/harbor_v2/config.ts").then((m) => {
  const c = m.harborBridgeConfig(process.env);
  const roles = Object.fromEntries(Object.entries(c.roles ?? {}).map(([k, v]) => [k, `${v.modelId}@${v.effort}`]));
  console.log(JSON.stringify({ route: c.route, model: c.modelId, effort: c.effort, variant: c.variant, roles,
    trialUsdCap: c.trialUsdCap, totalUsdCap: c.total?.capUsd ?? null, requestLimit: c.requestLimit, webSearch: c.webSearch }));
});' > ~/stage/config-check.json
cat ~/stage/config-check.json
echo "bridge bundle sha256 $(cat ~/bridge.sha256)"
echo HOST-SETUP-OK
