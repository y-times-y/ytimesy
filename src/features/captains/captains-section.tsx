import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Pencil, Plus } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useState } from "react";
import {
	CAPTAIN_LIMIT,
	type Captain,
	type CaptainInput,
	captainStatus,
	groupCaptains,
} from "#/domain/captain";
import type { SessionTurnStatus } from "#/domain/session-item";
import { compactRelativeAge } from "#/domain/sidebar-chats";
import { SUPER_AGENT_NAME } from "#/domain/y-squared";
import { CaptainAvatar } from "./captain-avatar";
import { CaptainDialog, LeaderNameDialog } from "./captain-dialog";
import {
	createCaptainFn,
	deleteCaptainFn,
	listCaptainsFn,
	renameLeaderFn,
	updateCaptainFn,
} from "./captains.fn";
import "./captains.css";

const LEADER_COLOR = "#e5e5e5";
const captainsKey = (projectId: string) => ["captains", projectId] as const;

/**
 * The sidebar's Captains section for the open project: its leader (the Super
 * agent, Y²) and the captains it has, grouped by label, each with its status,
 * the first line of its last answer and its age. Reads one small row set;
 * nothing here runs an agent.
 */
export function CaptainsSection({
	project,
	selectedChatId,
	openTurnStatus,
	nowMs,
	onSelectChat,
}: {
	project: {
		id: string;
		ySquaredId?: string | null;
		leaderName?: string | null;
	};
	selectedChatId?: string;
	/** The open chat's turn status: a change refreshes the list, so no timer is needed. */
	openTurnStatus?: SessionTurnStatus;
	nowMs: number;
	onSelectChat?: (chatId: string) => void;
}) {
	const queryClient = useQueryClient();
	const captains = useQuery({
		queryKey: captainsKey(project.id),
		queryFn: () => listCaptainsFn({ data: { projectId: project.id } }),
		staleTime: 30_000,
	});
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: captainsKey(project.id) });
	// The open chat's turn started or settled: its row (or its answer line) changed.
	useEffect(() => {
		if (openTurnStatus)
			void queryClient.invalidateQueries({ queryKey: captainsKey(project.id) });
	}, [openTurnStatus, project.id, queryClient]);

	const [editing, setEditing] = useState<Captain | "new" | null>(null);
	const list = captains.data ?? [];
	const labels = [
		...new Set(list.map((c) => c.label).filter((l): l is string => Boolean(l))),
	];
	const leaderName = project.leaderName || SUPER_AGENT_NAME;

	async function save(
		input: CaptainInput,
		existing?: Captain,
	): Promise<string | null> {
		const result = existing
			? await updateCaptainFn({
					data: { captainId: existing.id, captain: input },
				})
			: await createCaptainFn({
					data: { projectId: project.id, captain: input },
				});
		if (!result.ok) return result.error;
		await refresh();
		if (!existing) onSelectChat?.(result.captain.chatId);
		return null;
	}
	const [renaming, setRenaming] = useState(false);
	async function renameLeader(name: string): Promise<string | null> {
		const result = await renameLeaderFn({
			data: { projectId: project.id, name },
		});
		if (!result.ok) return result.error ?? "Could not rename.";
		await queryClient.invalidateQueries({ queryKey: ["projects"] });
		return null;
	}

	return (
		<section
			className="sidebar-y-section captains-section"
			data-section="captains"
			aria-labelledby="sidebar-section-captains"
		>
			<div className="sidebar-status-heading sidebar-section-header">
				<h3 className="sidebar-section-title" id="sidebar-section-captains">
					Captains
				</h3>
				<div className="sidebar-section-actions">
					<button
						type="button"
						className="captains-icon-button"
						aria-label="New captain"
						title="New captain"
						onClick={() => setEditing("new")}
					>
						<Plus size={14} strokeWidth={1.75} />
					</button>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger asChild>
							<button
								type="button"
								className="captains-icon-button"
								aria-label="Captains menu"
								title="Captains menu"
							>
								<Ellipsis size={14} strokeWidth={1.75} />
							</button>
						</DropdownMenu.Trigger>
						<DropdownMenu.Portal>
							<DropdownMenu.Content
								className="captains-menu"
								align="end"
								sideOffset={4}
							>
								<DropdownMenu.Item
									className="captains-menu-item"
									onSelect={() => setRenaming(true)}
								>
									Rename {leaderName}
								</DropdownMenu.Item>
								<DropdownMenu.Item className="captains-menu-item" disabled>
									{list.length} of {CAPTAIN_LIMIT} captains
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu.Portal>
					</DropdownMenu.Root>
				</div>
			</div>
			<ul className="sidebar-chats captains-list">
				<li
					className="sidebar-chat-row captains-row"
					data-role="leader"
					data-selected={project.ySquaredId === selectedChatId}
				>
					<button
						type="button"
						className="sidebar-chat"
						aria-current={
							project.ySquaredId && project.ySquaredId === selectedChatId
								? "page"
								: undefined
						}
						disabled={!project.ySquaredId}
						onClick={() =>
							project.ySquaredId && onSelectChat?.(project.ySquaredId)
						}
					>
						<span className="sidebar-chat-lead">
							<CaptainAvatar
								name={leaderName}
								color={LEADER_COLOR}
								size={24}
								leader
							/>
						</span>
						<span className="sidebar-chat-body">
							<span className="sidebar-chat-title">
								{leaderName} <span className="captains-badge">leader</span>
							</span>
							<span className="sidebar-chat-meta">
								{list.length
									? `${list.length} captain${list.length === 1 ? "" : "s"}`
									: "Y²"}
							</span>
						</span>
					</button>
				</li>
				{groupCaptains(list).map((group) => (
					<li key={group.label ?? ""} className="captains-group">
						{group.label ? (
							<div className="captains-group-label">{group.label}</div>
						) : null}
						<ul className="captains-group-list">
							{group.captains.map((captain) => (
								<CaptainRow
									key={captain.id}
									captain={captain}
									selected={captain.chatId === selectedChatId}
									nowMs={nowMs}
									onOpen={() => onSelectChat?.(captain.chatId)}
									onEdit={() => setEditing(captain)}
								/>
							))}
						</ul>
					</li>
				))}
			</ul>
			{!captains.isPending && !list.length ? (
				<div className="captains-empty">
					<strong>Give your Super agent a team</strong>
					<p>
						Captains are Super agents with a role: SEO, newsletter, release
						manager. They sleep until you @mention them, and cost nothing while
						idle.
					</p>
					<button
						type="button"
						className="captains-empty-button"
						onClick={() => setEditing("new")}
					>
						+ New captain
					</button>
				</div>
			) : null}
			{renaming ? (
				<LeaderNameDialog
					open
					onOpenChange={(open) => !open && setRenaming(false)}
					current={project.leaderName ?? ""}
					onSave={renameLeader}
				/>
			) : null}
			{editing ? (
				<CaptainDialog
					key={editing === "new" ? "new" : editing.id}
					open
					onOpenChange={(open) => !open && setEditing(null)}
					captain={editing === "new" ? undefined : editing}
					labels={labels}
					atLimit={list.length >= CAPTAIN_LIMIT}
					onSave={(input) =>
						save(input, editing === "new" ? undefined : editing)
					}
					onDelete={
						editing === "new"
							? undefined
							: async () => {
									await deleteCaptainFn({ data: { captainId: editing.id } });
									setEditing(null);
									await refresh();
									if (editing.chatId === selectedChatId && project.ySquaredId)
										onSelectChat?.(project.ySquaredId);
								}
					}
				/>
			) : null}
		</section>
	);
}

function CaptainRow({
	captain,
	selected,
	nowMs,
	onOpen,
	onEdit,
}: {
	captain: Captain;
	selected: boolean;
	nowMs: number;
	onOpen: () => void;
	onEdit: () => void;
}) {
	const status = captainStatus(captain);
	const age = compactRelativeAge(captain.lastAt ?? captain.createdAt, nowMs);
	const line =
		status === "needs"
			? "Needs you"
			: status === "working"
				? "Working…"
				: (captain.lastLine ?? "No messages yet");
	return (
		<li
			className="sidebar-chat-row captains-row"
			data-selected={selected}
			data-status={status}
			data-captain-id={captain.id}
		>
			<button
				type="button"
				className="sidebar-chat"
				data-selected={selected}
				aria-current={selected ? "page" : undefined}
				title={`${captain.name} · ${line}`}
				onClick={onOpen}
			>
				<span className="sidebar-chat-lead">
					<CaptainAvatar
						name={captain.name}
						color={captain.color}
						size={24}
						status={status}
					/>
				</span>
				<span className="sidebar-chat-body">
					<span className="sidebar-chat-title">{captain.name}</span>
					<span className="sidebar-chat-meta">{line}</span>
				</span>
			</button>
			<div className="sidebar-chat-trailing">
				<span className="sidebar-chat-age">{age}</span>
				<button
					type="button"
					className="captains-edit"
					aria-label={`Edit ${captain.name}`}
					title={`Edit ${captain.name}`}
					onClick={onEdit}
				>
					<Pencil size={12} strokeWidth={1.75} />
				</button>
			</div>
		</li>
	);
}
