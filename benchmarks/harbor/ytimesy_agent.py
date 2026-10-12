"""Harbor agent for the ytimesy builder (shell profile v13).

Usage:
  harbor run -d terminal-bench/terminal-bench@4.0.0 -k 5 \
    --agent-import-path benchmarks.harbor.ytimesy_agent:YtimesyAgent \
    --upload --public

The model loop runs on the host (benchmarks/harbor/builder-bridge.ts); every
command it issues runs in Harbor's sandbox through environment.exec, so the
task environment, timeouts and verifier are Harbor's own. Only the harness's
tool prerequisites (tmux, ripgrep, git, python3) are installed at setup,
exactly as in our own evaluator. No test or solution files are read.
"""

import asyncio
import json
import math
import os
import shlex
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REPO = Path(os.environ.get("YTIMESY_REPO", Path(__file__).resolve().parents[2]))
BRIDGE = REPO / "benchmarks" / "harbor" / "builder-bridge.ts"
REQUEST = "@@YTIMESY_HARBOR@@"

# Same guest prerequisites as our evaluator (terminal-bench-machines.ts).
SETUP = r"""set -eu
project=$(pwd)
if command -v apt-get >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq git python3 curl xz-utils ca-certificates ripgrep tmux >/dev/null
elif command -v dnf >/dev/null; then
  dnf install -y -q git python3 curl xz ca-certificates ripgrep tmux >/dev/null || true
elif command -v yum >/dev/null; then
  yum install -y -q git python3 curl xz ca-certificates tmux >/dev/null || true
elif command -v apk >/dev/null; then
  apk add -q git python3 curl xz ca-certificates ripgrep tmux bash >/dev/null || true
fi
# Distributions without a ripgrep package get the official static build.
if ! command -v rg >/dev/null; then
  curl -fsSL https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz \
    | tar -xz -C /usr/local/bin --strip-components=1 ripgrep-14.1.1-x86_64-unknown-linux-musl/rg
fi
rg --version >/dev/null
if [ "$project" = / ]; then project=/app; mkdir -p /app; fi
cd "$project"
# Setup runs as root; the project may belong to the image's agent user, which git
# would otherwise refuse as "dubious ownership" for every user but the owner.
git config --system --add safe.directory "$project"
if [ ! -d .git ]; then
  # Older git releases lack --initial-branch; set the branch name separately.
  git init -q && git symbolic-ref HEAD refs/heads/evaluation-frozen
  git config user.name 'Evaluation fixture'
  git config user.email 'evaluation@ytimesy.invalid'
  printf '\nnode_modules/\n.next/\n.ytimesy/\n__pycache__/\n' >> .git/info/exclude
  git add -A
  git commit -q --allow-empty -m 'Frozen benchmark environment'
fi
# Setup runs as root; images that run the agent as another user own the project,
# so the repository must belong to that owner too.
chown -R "$(stat -c %u:%g .)" .git
printf '%s\n' "$project"
"""


class YtimesyAgent(BaseAgent):
    # Task-supplied skills go where our builder discovers them (.agents/skills),
    # as Harbor's Codex agent copies them into Codex's skills directory.
    # Task MCP servers (sse / streamable-http) are reachable from the task's network,
    # so the builder calls them through the mcp-call helper installed in the container.
    capabilities = AgentCapabilities(skills=True, mcp_servers=True)

    @staticmethod
    def name() -> str:
        return "ytimesy"

    def version(self) -> str | None:
        return os.environ.get("YTIMESY_HARNESS_VERSION", "v13-shell")

    async def setup(self, environment: BaseEnvironment) -> None:
        result = await environment.exec(SETUP, timeout_sec=900, user="root")
        if result.return_code != 0:
            raise RuntimeError(
                f"ytimesy prerequisites failed: {(result.stderr or result.stdout or '')[-800:]}"
            )
        self.cwd = (result.stdout or "/app").strip().splitlines()[-1]
        if self.skills_dir:
            project = shlex.quote(self.cwd)
            skills = await environment.exec(
                f"mkdir -p {project}/.agents/skills && cp -r {shlex.quote(self.skills_dir)}/* {project}/.agents/skills/ 2>/dev/null; "
                f"grep -qx '.agents/' {project}/.git/info/exclude 2>/dev/null || echo '.agents/' >> {project}/.git/info/exclude; "
                f"chown -R \"$(stat -c %u:%g {project})\" {project}/.agents {project}/.git",
                timeout_sec=120,
                user="root",
            )
            if skills.return_code != 0:
                self.logger.warning("ytimesy: copying skills failed: %s", skills.stderr)
        self.mcp_names = []
        remote = [s for s in self.mcp_servers if s.transport in ("sse", "streamable-http") and s.url]
        if remote:
            Path(self.logs_dir).mkdir(parents=True, exist_ok=True)
            config = Path(self.logs_dir) / "mcp-servers.json"
            config.write_text(json.dumps([{"name": s.name, "transport": s.transport, "url": s.url} for s in remote]))
            await environment.upload_file(config, "/etc/ytimesy-mcp.json")
            await environment.upload_file(Path(__file__).with_name("mcp_call.py"), "/usr/local/bin/mcp-call")
            await environment.exec("chmod 755 /usr/local/bin/mcp-call", timeout_sec=30, user="root")
            self.mcp_names = [s.name for s in remote]

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        logs = Path(self.logs_dir)
        logs.mkdir(parents=True, exist_ok=True)
        arguments = json.dumps(
            {
                "instruction": instruction,
                "cwd": getattr(self, "cwd", "/app"),
                "mcpServers": getattr(self, "mcp_names", []),
                "logsDir": str(logs),
                # Harbor enforces the task's own agent timeout; this is only a backstop.
                "timeoutSeconds": 8 * 3600,
            }
        )
        stderr = open(logs / "ytimesy-bridge.log", "wb")
        # On remote hosts the bridge ships as one bundled file (no repo checkout).
        bundle = os.environ.get("YTIMESY_BRIDGE_BUNDLE")
        command = (
            ["node", bundle, arguments]
            if bundle
            else ["node", "--env-file=.env", "--import", "tsx", str(BRIDGE), arguments]
        )
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=REPO,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
            limit=64 * 1024 * 1024,
        )
        write_lock = asyncio.Lock()
        inflight: set[asyncio.Task] = set()

        async def answer(request: dict) -> None:
            seconds = max(1, math.ceil(request["timeoutMs"] / 1000))
            try:
                result = await environment.exec(request["command"], timeout_sec=seconds)
                reply = {
                    "id": request["id"],
                    "exitCode": result.return_code,
                    "stdout": result.stdout or "",
                    "stderr": result.stderr or "",
                }
            except Exception as error:  # surfaced to the builder as a failed command
                reply = {"id": request["id"], "exitCode": 124, "stdout": "", "stderr": str(error)[-2000:]}
            assert process.stdin is not None
            async with write_lock:
                process.stdin.write((json.dumps(reply) + "\n").encode())
                await process.stdin.drain()

        try:
            assert process.stdout is not None
            async for raw in process.stdout:
                line = raw.decode("utf-8", errors="replace")
                if not line.startswith(REQUEST):
                    continue
                message = json.loads(line[len(REQUEST):])
                if message.get("op") == "exec":
                    task = asyncio.create_task(answer(message))
                    inflight.add(task)
                    task.add_done_callback(inflight.discard)
                elif message.get("op") == "done":
                    context.n_input_tokens = message.get("inputTokens")
                    context.n_cache_tokens = message.get("cachedTokens")
                    context.n_output_tokens = message.get("outputTokens")
                    context.cost_usd = message.get("costUsd")
                    if message.get("failure"):
                        self.logger.warning("ytimesy builder: %s", message["failure"])
                    break
        finally:
            for task in inflight:
                task.cancel()
            if process.returncode is None:
                process.kill()
            await process.wait()
            stderr.close()
