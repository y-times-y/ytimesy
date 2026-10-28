import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, GitBranch, Search } from "lucide-react";
import { useMemo, useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import type { Project } from "#/domain/projects";
import {
	defaultChatBaseBranch,
	filterBaseBranches,
} from "#/domain/session-branch";
import { requestJson } from "../projects/api";

export type RepositoryBranches = {
	readonly branches: readonly string[];
	readonly defaultBranch: string;
	readonly truncated?: boolean;
};

/** Rows rendered at once; search reaches the rest. */
const VISIBLE_BRANCHES = 200;

export function repositoryBranchesQueryKey(
	project: Pick<Project, "installationId" | "repositoryId">,
) {
	return [
		"github",
		"branches",
		project.installationId,
		project.repositoryId,
	] as const;
}

/** Only a project with a GitHub repository has branches to start from. */
export function projectHasRepository(project?: Project): project is Project {
	return Boolean(
		project?.fullName && project.repositoryId > 0 && project.installationId > 0,
	);
}

/**
 * New chat: "from <branch>", choosing the branch the chat starts from.
 * In a chat: the branch it is on now, read-only (the agent may switch it).
 */
export function BaseBranchPicker({
	project,
	value,
	onChange,
	currentBranch,
	locked = false,
}: {
	project?: Project;
	/** The branch the person picked; null keeps the default. */
	value: string | null;
	onChange: (branch: string) => void;
	/** The open chat's branch, shown when locked. */
	currentBranch?: string | null;
	locked?: boolean;
}) {
	if (!projectHasRepository(project)) return null;
	if (locked)
		return currentBranch ? (
			<span
				className="context-select base-branch-current"
				title={`Branch ${currentBranch}`}
			>
				<GitBranch size={14} aria-hidden="true" />
				<span>{currentBranch}</span>
			</span>
		) : null;
	return (
		<NewChatBranchPicker
			key={project.id}
			project={project}
			value={value}
			onChange={onChange}
		/>
	);
}

function NewChatBranchPicker({
	project,
	value,
	onChange,
}: {
	project: Project;
	value: string | null;
	onChange: (branch: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const branches = useQuery({
		queryKey: repositoryBranchesQueryKey(project),
		queryFn: () =>
			requestJson<RepositoryBranches>(
				`/api/github/branches?installationId=${project.installationId}&repositoryId=${project.repositoryId}`,
			),
		retry: false,
		// Loaded with the new-chat composer, so opening the menu never waits.
		staleTime: 60_000,
		placeholderData: keepPreviousData,
	});
	const fallback = defaultChatBaseBranch({
		projectBranch: project.branch,
		defaultBranch: branches.data?.defaultBranch ?? project.branch,
	});
	const selected = value ?? fallback;
	const matches = useMemo(
		() => filterBaseBranches(branches.data?.branches ?? [], query),
		[branches.data?.branches, query],
	);
	function choose(branch: string) {
		onChange(branch);
		setOpen(false);
		setQuery("");
	}
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next && branches.isStale) void branches.refetch();
				if (!next) setQuery("");
			}}
		>
			<PopoverTrigger
				className="context-select base-branch-select"
				aria-label={`Start from ${selected}`}
				title={`Start from ${selected}`}
			>
				<span className="base-branch-from">from</span>
				<span className="base-branch-name">{selected}</span>
				<ChevronDown className="size-3" aria-hidden="true" />
			</PopoverTrigger>
			<PopoverContent
				side="bottom"
				align="start"
				collisionPadding={12}
				avoidCollisions={false}
				className="project-picker base-branch-picker"
			>
				<label className="model-picker-search project-picker-search">
					<Search size={16} aria-hidden="true" />
					<input
						type="search"
						placeholder="Search branches"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						aria-label="Search branches"
					/>
				</label>
				<div
					className="project-picker-list"
					role="listbox"
					aria-label="Branches"
				>
					{branches.isPending ? (
						<div className="project-picker-skeleton" aria-busy="true">
							<span />
							<span />
							<span />
						</div>
					) : (
						matches.slice(0, VISIBLE_BRANCHES).map((branch) => (
							<button
								key={branch}
								type="button"
								role="option"
								aria-selected={branch === selected}
								className="project-picker-choice base-branch-choice"
								data-selected={branch === selected ? "true" : undefined}
								onClick={() => choose(branch)}
								title={branch}
							>
								<GitBranch size={16} aria-hidden="true" />
								<span className="project-picker-name">
									<strong>{branch}</strong>
								</span>
								{branch === branches.data?.defaultBranch ? (
									<small className="project-picker-adding">Default</small>
								) : null}
								{branch === selected ? (
									<Check size={14} aria-hidden="true" />
								) : null}
							</button>
						))
					)}
					{!branches.isPending && matches.length === 0 ? (
						<p className="project-picker-empty">
							{branches.error
								? branches.error.message
								: query.trim()
									? "No branches match."
									: "No branches."}
						</p>
					) : null}
				</div>
			</PopoverContent>
		</Popover>
	);
}
