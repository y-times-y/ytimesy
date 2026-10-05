"""Harbor 0.23.0 external adapter for the actual durable ytimesy worker."""

import asyncio
import json
import os
import shlex
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.agents.options import AgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class ProductionOptions(AgentOptions):
    protocol_path: str
    task_id: str
    application_path: str
    checkout_path: str = "/workspace"


class YtimesyProductionAgent(BaseAgent):
    """Never copy database/provider credentials or verifier assets into the task VM."""

    options_model = ProductionOptions

    @staticmethod
    def name() -> str:
        return "ytimesy-production"

    def version(self) -> str:
        return "1"

    async def setup(self, environment: BaseEnvironment) -> None:
        if os.environ.get("YTIMESY_EVALUATION_APPROVED") != "codex-subscription":
            raise ValueError("Subscription pilot approval is missing")
        self.protocol = json.loads(Path(self.options.protocol_path).read_text())
        if self.protocol["phase"] != "development":
            raise ValueError("Final holdouts are not authorized by pilot approval")
        self.task = next(t for t in self.protocol["tasks"] if t["id"] == self.options.task_id)
        if self.model_name != self.protocol["modelId"]:
            raise ValueError("Harbor model differs from the production model")
        commit = await environment.exec(
            f"git -C {shlex.quote(self.options.checkout_path)} rev-parse HEAD", timeout_sec=15
        )
        if commit.return_code or commit.stdout.strip() != self.task["commit"]:
            raise ValueError("Harbor verifier environment differs from the coding commit")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if instruction != self.task["prompt"]:
            raise ValueError("Harbor task instruction differs from the frozen production prompt")
        output = self.logs_dir / "production"
        process = await asyncio.create_subprocess_exec(
            "node", "--env-file-if-exists=.env", "--import", "tsx",
            "scripts/evaluate-production-arm.ts", str(Path(self.options.protocol_path).resolve()),
            self.options.task_id, str(output.resolve()),
            cwd=self.options.application_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            code = await asyncio.wait_for(process.wait(), self.protocol["limits"]["durationSeconds"] + 180)
            if code:
                raise RuntimeError("Production evaluation bridge failed; no fallback was used")
        finally:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 60)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
        result = json.loads((output / "result.json").read_text())
        for name in result["patchFiles"]:
            patch = output / name
            remote = f"/tmp/ytimesy-evaluation-{patch.stem}.patch"
            await environment.upload_file(patch, remote)
            applied = await environment.exec(
                f"git -C {shlex.quote(self.options.checkout_path)} apply --index --binary {shlex.quote(remote)}",
                timeout_sec=30,
            )
            if applied.return_code:
                raise RuntimeError("Reviewed production patches failed to integrate in Harbor")
        changed = await environment.exec(
            f"git -C {shlex.quote(self.options.checkout_path)} diff --cached --name-only -z {shlex.quote(self.task['commit'])}",
            timeout_sec=15,
        )
        paths = [path for path in changed.stdout.split("\0") if path]
        if changed.return_code or any(path not in self.task["allowedPaths"] for path in paths):
            raise RuntimeError("Production patch changed a protected or unrelated Harbor path")
        context.metadata = {
            "production_root_id": result["rootId"],
            "transport": "codex-subscription",
            "production_queue": True,
            "model_loop_in_evaluator": False,
            "resource_equivalence_verified": False,
        }
