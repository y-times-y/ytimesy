import { ArrowRight } from "lucide-react";
import { PullStateIcon } from "./pull-request-list";
import { ChatRail, type PullRequestChat } from "./pull-request-marks";

type ChainPull = {
	readonly number: number;
	readonly state: "open" | "draft" | "merged" | "closed";
};

const STATE_WORD: Record<ChainPull["state"], string> = {
	open: "open",
	draft: "draft",
	merged: "merged",
	closed: "closed",
};

/**
 * Where a piece of work stands: the issue, the chat working on it, the pull
 * request that closes it, and the branch it lands on. Each step that exists
 * opens its page; a step that does not exist yet says so.
 */
export function WorkChain({
	issue,
	chat,
	pulls,
	base = "main",
	onOpenChat,
	onOpenPullRequest,
}: {
	issue: { readonly number: number };
	chat?: PullRequestChat;
	pulls: readonly ChainPull[];
	base?: string;
	onOpenChat?: (chatId: string) => void;
	onOpenPullRequest?: (number: number) => void;
}) {
	const landed = pulls.some((pull) => pull.state === "merged");
	return (
		<ol className="gh-chain" aria-label="Issue, chat, pull request, branch">
			<li className="gh-chain-node" data-step="issue">
				<span className="gh-chain-label">Issue</span>
				<span>#{issue.number}</span>
			</li>
			<Arrow />
			<li
				className="gh-chain-node"
				data-step="chat"
				data-empty={!chat || undefined}
			>
				<span className="gh-chain-label">Chat</span>
				{chat ? (
					<ChatRail chat={chat} onOpen={onOpenChat} />
				) : (
					<span className="gh-chain-none">None yet</span>
				)}
			</li>
			<Arrow />
			<li
				className="gh-chain-node"
				data-step="pull-request"
				data-empty={!pulls.length || undefined}
			>
				<span className="gh-chain-label">Pull request</span>
				{pulls.length ? (
					<span className="gh-chain-pulls">
						{pulls.map((pull) => (
							<button
								key={pull.number}
								type="button"
								className="gh-chain-pull"
								onClick={() => onOpenPullRequest?.(pull.number)}
							>
								<PullStateIcon state={pull.state} />#{pull.number}
								<span className="gh-chain-state">{STATE_WORD[pull.state]}</span>
							</button>
						))}
					</span>
				) : (
					<span className="gh-chain-none">None yet</span>
				)}
			</li>
			<Arrow />
			<li
				className="gh-chain-node"
				data-step="base"
				data-reached={landed || undefined}
			>
				<span className="gh-chain-label">Branch</span>
				<code>{base}</code>
			</li>
		</ol>
	);
}

function Arrow() {
	return (
		<li className="gh-chain-arrow" aria-hidden="true">
			<ArrowRight size={14} />
		</li>
	);
}
