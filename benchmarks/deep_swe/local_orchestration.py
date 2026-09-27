"""DeepSWE adapter for the local orchestration policy."""

from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext

from benchmarks.deep_swe.chatgpt_codex_control import ChatgptCodexControlAgent


ORCHESTRATION_INSTRUCTIONS = " ".join(
    [
        "You can delegate bounded work to isolated child agents with the task tools.",
        "Delegate only when work is independent and parallelism, specialization, or an adversarial second pass will materially improve the outcome; do not delegate trivial work or steps that depend on your unfinished result.",
        "Keep at most 3 direct child tasks active and at most 8 tasks active across the tree.",
        "A child does not inherit this conversation, so its prompt must include the concrete objective, relevant paths and constraints, expected evidence or deliverable, and what it must not change.",
        "After starting children, continue useful work yourself instead of waiting. Check child status after meaningful local progress, not in a tight polling loop.",
        "Use child messaging to correct scope or request missing evidence. If a child is still working when waiting would delay the outcome, ask it to wrap up with its strongest current result.",
        "Children may delegate under the same rules only when another independent split is genuinely useful.",
        "Before your final response, inspect every delegated task, incorporate useful results, resolve conflicts, and verify important child claims against the workspace. Never present an unverified child claim as your own confirmed result.",
    ]
)


class LocalOrchestrationAgent(ChatgptCodexControlAgent):
    """Apply the product's orchestration policy to Codex's local child agents."""

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("config_toml", "[features]\nmulti_agent = true\n")
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "ytimesy-local-orchestration"

    @staticmethod
    def compose_instruction(instruction: str) -> str:
        return f"{ORCHESTRATION_INSTRUCTIONS}\n\nTask:\n{instruction}"

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await super().run(
            self.compose_instruction(instruction),
            environment,
            context,
        )
