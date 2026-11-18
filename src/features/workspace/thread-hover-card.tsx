import {
	Cloud,
	GitMerge,
	GitPullRequest,
	GitPullRequestClosed,
	GitPullRequestDraft,
} from "lucide-react";
import { HoverCard } from "radix-ui";
import type { ReactNode } from "react";
import { modelBaseId, modelDisplayName } from "#/domain/model-display";
import type { SidebarPullRequest } from "#/domain/sidebar-chat-status";
import {
	ModelProviderLogo,
	modelLogoProvider,
} from "../sessions/model-provider-logo";
import { ThreadArt } from "./thread-art";

/** Open after the pointer rests this long; Radix also opens it on keyboard focus. */
export const THREAD_CARD_OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 80;

export type ThreadCardData = {
	/** The chat id, which picks the thread's picture. */
	readonly artId: string;
	/** The thread's short id ("WEB-3F9A"). */
	readonly id: string | null;
	readonly title: string;
	readonly projectName: string | null;
	readonly projectColor?: string;
	/** What the row's status icon says ("Working", "Needs you"). */
	readonly status: string | null;
	readonly model: string | null;
	/** Has a cloud workspace; the row holds nothing more about a machine. */
	readonly cloud: boolean;
	/** The project's machine in words (size, vCPU, RAM, disk); null when unknown. */
	readonly machine?: string | null;
	/** The row's pull request (the sidebar holds its number, state and checks only). */
	readonly pullRequest: SidebarPullRequest | null;
};

const PR_ICONS = {
	open: GitPullRequest,
	draft: GitPullRequestDraft,
	merged: GitMerge,
	closed: GitPullRequestClosed,
} as const;

/**
 * A card beside a thread row (desktop hover, keyboard focus) with what the
 * row already holds: id, title, project, machine, model and pull request.
 * It reads nothing new. Radix places it beside the row and keeps it inside
 * the viewport; touch never opens it.
 */
export function ThreadHoverCard({
	data,
	onOpenPullRequest,
	children,
}: {
	data: ThreadCardData;
	onOpenPullRequest?: () => void;
	children: ReactNode;
}) {
	const { pullRequest: pr } = data;
	const PrIcon = pr ? PR_ICONS[pr.state] : null;
	return (
		<HoverCard.Root
			openDelay={THREAD_CARD_OPEN_DELAY_MS}
			closeDelay={CLOSE_DELAY_MS}
		>
			<HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content
					className="thread-card"
					side="right"
					align="start"
					sideOffset={10}
					collisionPadding={12}
					avoidCollisions
				>
					<div className="thread-card-head">
						<ThreadArt id={data.artId} size={24} />
						{data.id ? <span className="thread-id">{data.id}</span> : null}
						{data.status ? (
							<span className="thread-card-status">{data.status}</span>
						) : null}
					</div>
					<p className="thread-card-title">{data.title}</p>
					<dl className="thread-card-facts">
						{data.projectName ? (
							<>
								<dt>Project</dt>
								<dd>{data.projectName}</dd>
							</>
						) : null}
						{data.cloud ? (
							<>
								<dt>Machine</dt>
								<dd>
									<span className="thread-card-cloud">
										<Cloud size={12} strokeWidth={1.75} aria-hidden="true" />
										Cloud
									</span>
									{data.machine ? (
										<span className="thread-card-machine">{data.machine}</span>
									) : null}
								</dd>
							</>
						) : null}
						{data.model ? (
							<>
								<dt>Model</dt>
								<dd>
									<span className="thread-card-model-logo" aria-hidden="true">
										<ModelProviderLogo
											provider={modelLogoProvider(modelBaseId(data.model))}
											size={14}
										/>
									</span>
									<span title={data.model}>{modelDisplayName(data.model)}</span>
								</dd>
							</>
						) : null}
					</dl>
					{pr && PrIcon ? (
						<div className="thread-card-section">
							<p className="thread-card-section-title">Pull requests</p>
							<a
								className="thread-card-pr"
								data-pr={pr.state}
								href={pr.url}
								target="_blank"
								rel="noreferrer"
								title="Opens the pull request here; Ctrl or ⌘ click opens GitHub"
								onClick={(event) => {
									if (
										!onOpenPullRequest ||
										event.metaKey ||
										event.ctrlKey ||
										event.shiftKey ||
										event.button !== 0
									)
										return;
									event.preventDefault();
									onOpenPullRequest();
								}}
							>
								<PrIcon size={14} strokeWidth={2} aria-hidden="true" />
								<span>#{pr.number}</span>
								<span className="thread-card-pr-state">{pr.state}</span>
							</a>
						</div>
					) : null}
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}
