"""Official Codex agent with the network access required for ChatGPT login."""

from pier.agents.installed.codex import Codex
from pier.models.agent.network import NetworkAllowlist


class ChatgptCodexControlAgent(Codex):
    """Run the unmodified Codex control through an existing ChatGPT login."""

    @staticmethod
    def name() -> str:
        return "codex-chatgpt-control"

    def network_allowlist(self) -> NetworkAllowlist:
        upstream = super().network_allowlist()
        return NetworkAllowlist(
            domains=sorted({*upstream.domains, "chatgpt.com"}),
        )
