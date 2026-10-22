"""Harbor agent for the current ytimesy builder harness (bridge v2).

Usage (docs/harbor-bridge-v2.md):
  YTIMESY_HARBOR_ROUTE=anthropic YTIMESY_HARBOR_APPROVED=anthropic \
  YTIMESY_HARBOR_TOTAL_USD_CAP=10 YTIMESY_HARBOR_SPEND_LEDGER=.ytimesy/harbor-v2/ledger.jsonl \
  harbor run -d terminal-bench/terminal-bench@4.0.0 -i terminal-bench/shadow-relay \
    -a evals.harbor_v2.agent:YtimesyHarborV2Agent ...

Setup (guest prerequisites, task skills, the mcp-call helper) is the frozen
v13 agent's, reused by import; benchmarks/harbor is never modified. The model
loop runs on the host (evals/harbor_v2/bridge.ts); every command it issues
runs in Harbor's sandbox through environment.exec. The bridge writes
trajectory.json (ATIF) and ytimesy-trace.json into this trial's logs
directory. No test or solution files are read.
"""

import asyncio
import json
import math
import os
import time
import tomllib
from pathlib import Path

from benchmarks.harbor.ytimesy_agent import REQUEST, YtimesyAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REPO = Path(os.environ.get("YTIMESY_REPO", Path(__file__).resolve().parents[2]))
BRIDGE = REPO / "evals" / "harbor_v2" / "bridge.ts"
# Harbor enforces the task's agent timeout itself; this is only a backstop
# when the timeout cannot be read.
BACKSTOP_SECONDS = 8 * 3600


def trial_task_name(logs_dir: Path) -> str | None:
    """The trial's task name (e.g. terminal-bench/shadow-relay) from its config.json."""
    try:
        config = json.loads((logs_dir.parent / "config.json").read_text())
        task = config.get("task") or {}
        return task.get("name") or (Path(task["path"]).name if task.get("path") else None)
    except Exception:
        return None


def agent_timeout_seconds(logs_dir: Path) -> float:
    """The agent timeout Harbor applies to this trial, as Harbor computes it.

    Read from the trial's config.json (next to the agent's logs directory) and
    the task's cached task.toml. YTIMESY_HARBOR_AGENT_TIMEOUT_SEC overrides it.
    """
    override = os.environ.get("YTIMESY_HARBOR_AGENT_TIMEOUT_SEC")
    if override:
        return float(override)
    try:
        config = json.loads((logs_dir.parent / "config.json").read_text())
        agent = config.get("agent") or {}
        base = agent.get("override_timeout_sec")
        if base is None:
            task = config.get("task") or {}
            if task.get("path"):
                toml_path = Path(task["path"]) / "task.toml"
            else:
                name, ref = task.get("name") or "", (task.get("ref") or "").removeprefix("sha256:")
                toml_path = Path.home() / ".cache" / "harbor" / "tasks" / "packages" / name / ref / "task.toml"
            base = tomllib.loads(toml_path.read_text())["agent"]["timeout_sec"]
        multiplier = config.get("agent_timeout_multiplier")
        if multiplier is None:
            multiplier = config.get("timeout_multiplier") or 1.0
        seconds = float(base) * float(multiplier)
        if agent.get("max_timeout_sec"):
            seconds = min(seconds, float(agent["max_timeout_sec"]))
        return seconds
    except Exception:
        return BACKSTOP_SECONDS


class YtimesyHarborV2Agent(YtimesyAgent):
    capabilities = AgentCapabilities(skills=True, mcp_servers=True, atif=True)

    @staticmethod
    def name() -> str:
        return "ytimesy-v2"

    def version(self) -> str | None:
        return os.environ.get("YTIMESY_HARNESS_VERSION", "harbor-v2")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        started = time.monotonic()
        logs = Path(self.logs_dir)
        logs.mkdir(parents=True, exist_ok=True)
        # The bridge's deadline ends a little before Harbor's so it can still
        # write its trace, trajectory and spend settlement.
        timeout = max(60.0, agent_timeout_seconds(logs) - 60)
        arguments = json.dumps(
            {
                "instruction": instruction,
                "cwd": getattr(self, "cwd", "/app"),
                "mcpServers": getattr(self, "mcp_names", []),
                "logsDir": str(logs),
                "trialId": logs.parent.name,
                "task": trial_task_name(logs),
                "timeoutSeconds": timeout,
            }
        )
        stderr = open(logs / "ytimesy-bridge.log", "wb")
        bundle = os.environ.get("YTIMESY_BRIDGE_BUNDLE")
        route = os.environ.get("YTIMESY_HARBOR_ROUTE", "")
        env = dict(os.environ)
        node = ["node"]
        if route == "codex-subscription":
            # The subscription transport reads the product's server config;
            # the bridge then points DATABASE_URL at a loopback database.
            node.append("--env-file=.env")
        else:
            # API routes need no database: make any accidental use fail loudly.
            env.pop("DATABASE_URL", None)
        command = node + ([bundle, arguments] if bundle else ["--import", "tsx", str(BRIDGE), arguments])
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=REPO,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
            limit=64 * 1024 * 1024,
        )
        write_lock = asyncio.Lock()
        inflight: set[asyncio.Task] = set()
        done: dict | None = None

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
                    done = message
                    break
        finally:
            for task in inflight:
                task.cancel()
            if process.returncode is None:
                process.kill()
            await process.wait()
            stderr.close()
        if done is None:
            raise RuntimeError("ytimesy bridge exited without a result; see agent/ytimesy-bridge.log")
        context.n_input_tokens = done.get("inputTokens")
        context.n_cache_tokens = done.get("cachedTokens")
        context.n_output_tokens = done.get("outputTokens")
        context.cost_usd = done.get("costUsd")
        context.metadata = {
            **(context.metadata or {}),
            "ytimesy": {
                "requests": done.get("requests"),
                "reviewRounds": done.get("reviewRounds"),
                "failure": done.get("failure"),
                "efficiency": done.get("efficiency"),
                "seconds": round(time.monotonic() - started, 1),
            },
        }
        # A refusal (spending cap, stop file) or a setup failure is not an
        # agent attempt: fail the trial so it is not scored as a 0.
        if done.get("refused"):
            raise RuntimeError(f"ytimesy trial refused before inference: {done['refused']}")
        if done.get("setupFailed"):
            raise RuntimeError(f"ytimesy bridge setup failed: {done.get('failure')}")
        if done.get("failure"):
            self.logger.warning("ytimesy builder: %s", done["failure"])
