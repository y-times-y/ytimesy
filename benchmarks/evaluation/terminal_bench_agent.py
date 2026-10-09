"""Private Harbor bridge to ytimesy's real worker and isolated task machines."""

import asyncio
import json
import os
import shlex
import shutil
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.agents.options import AgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.task.task import strip_canary
from harbor.models.verifier.result import VerifierResult
from harbor.verifier.base import BaseVerifier


class TerminalBenchOptions(AgentOptions):
    application_path: str
    task_path: str


class YtimesyTerminalBenchAgent(BaseAgent):
    options_model = TerminalBenchOptions

    @staticmethod
    def name() -> str:
        return "ytimesy-terminal-bench"

    def version(self) -> str:
        return "1"

    async def setup(self, environment: BaseEnvironment) -> None:
        if os.environ.get("YTIMESY_EVALUATION_APPROVED") != "codex-subscription":
            raise ValueError("Subscription pilot approval is missing")
        if self.model_name != "gpt-6.1-sol":
            raise ValueError("The diagnostic model is pinned to gpt-6.1-sol")
        self.task_path = Path(self.options.task_path).resolve()
        if self.task_path.name not in {
            "session-window-debug", "nextjs-performance", "wal-recovery-ordering"
        }:
            raise ValueError("Only the three selected diagnostic tasks are authorized")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if instruction != strip_canary((self.task_path / "instruction.md").read_text()):
            raise ValueError("Harbor instructions differ from the frozen task")
        application = Path(self.options.application_path).resolve()
        output = application / ".ytimesy" / "terminal-bench-pilot" / "runs" / self.logs_dir.parent.name
        output.mkdir(parents=True, mode=0o700, exist_ok=False)
        # Credentials remain in the operator process; never upload its logs/env.
        with (output / "operator.log").open("wb") as log:
            process = await asyncio.create_subprocess_exec(
                "node", "--env-file=.env", "--import", "tsx",
                "scripts/evaluate-terminal-bench.ts", str(self.task_path), str(output), "run",
                cwd=application, stdout=log, stderr=log,
            )
            try:
                code = await asyncio.wait_for(process.wait(), timeout=2400)
                if code:
                    raise RuntimeError("Production bridge failed; inspect private failure/evidence files")
            finally:
                if process.returncode is None:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), timeout=120)
                    except asyncio.TimeoutError:
                        process.kill()
                        await process.wait()
                        raise RuntimeError("Cleanup was interrupted; reconcile the private ownership ledger")
        result = json.loads((output / "result.json").read_text())
        if not result.get("completed"):
            raise RuntimeError("The real harness did not complete the task")
        await environment.upload_file(output / "artifacts.tar.gz", "/tmp/ytimesy-reviewed-artifacts.tar.gz")
        extractor = (
            "import json,pathlib,shutil,tarfile; "
            f"allowed=json.loads({json.dumps(json.dumps(result['artifacts']))}); "
            "archive=tarfile.open('/tmp/ytimesy-reviewed-artifacts.tar.gz'); "
            "members=archive.getmembers(); "
            "assert all(not pathlib.PurePosixPath(m.name).is_absolute() "
            "and '..' not in pathlib.PurePosixPath(m.name).parts "
            "and (m.isfile() or m.isdir()) "
            "and any('/'+m.name.rstrip('/')==p.rstrip('/') "
            "or ('/'+m.name).startswith(p.rstrip('/')+'/') for p in allowed) "
            "for m in members), 'Artifact outside task contract'; "
            "[(shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink()) "
            "for s in allowed if (p:=pathlib.Path(s)).exists() or p.is_symlink()]; "
            "archive.extractall('/', members=members)"
        )
        applied = await environment.exec(f"python3 -c {shlex.quote(extractor)}", timeout_sec=60)
        if applied.return_code:
            raise RuntimeError("Reviewed task artifacts failed safe extraction")
        usage = result["usage"]
        context.n_input_tokens = usage["inputTokens"]
        context.n_cache_tokens = usage["cacheReadTokens"]
        context.n_output_tokens = usage["outputTokens"]
        context.metadata = {
            "production_root_id": result["rootId"],
            "production_queue": True,
            "agent_seconds": result["agentSeconds"],
            "diagnostic_only": True,
            "native_codex_comparison": False,
            "private_operator_artifacts": str(output),
            "limits": {"seconds": 1800, "requests": 100, "tokens": 4000000},
        }


class YtimesyNativeLinuxVerifier(BaseVerifier):
    """Only the timing-sensitive Next.js diagnostic uses a native Linux verifier."""

    def __init__(self, *, application_path: str, **kwargs):
        super().__init__(**kwargs)
        self.application = Path(application_path).resolve()

    async def verify(self) -> VerifierResult:
        if self.task.paths.task_dir.name != "nextjs-performance":
            raise ValueError("Native Linux verifier is authorized for Next.js only")
        operator = self.application / ".ytimesy" / "terminal-bench-pilot" / "runs" / self.trial_paths.trial_dir.name
        output = operator / "native-verifier"
        with (operator / "native-verifier.log").open("wb") as log:
            process = await asyncio.create_subprocess_exec(
                "node", "--env-file=.env", "--import", "tsx", "scripts/grade-terminal-bench.ts",
                str(self.task.paths.task_dir), str(operator / "artifacts.tar.gz"), str(output),
                cwd=self.application, stdout=log, stderr=log,
            )
            try:
                code = await asyncio.wait_for(process.wait(), timeout=650)
            finally:
                if process.returncode is None:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), timeout=350)
                    except asyncio.TimeoutError:
                        process.kill()
                        await process.wait()
                        raise RuntimeError("Verifier cleanup interrupted; reconcile private resource ledger")
        if code:
            raise RuntimeError("Native Linux verification failed; inspect private operator logs")
        result = json.loads((output / "result.json").read_text())
        self.trial_paths.verifier_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(output / "verifier-execution.json", self.trial_paths.verifier_dir / "native-verifier-execution.json")
        (self.trial_paths.verifier_dir / "reward.txt").write_text(str(result["reward"]))
        return VerifierResult(rewards={"reward": result["reward"]})
