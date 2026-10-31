import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	Check,
	ChevronDown,
	ExternalLink,
	GitBranch,
	Layers,
	Plus,
	RefreshCw,
	Search,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import {
	addedProjectBranch,
	GITHUB_LIST_UNREACHABLE,
	githubRepositoryListMessage,
	projectPickerSections,
	scratchRepositoryName,
} from "#/domain/add-project";
import type { Project, RepositoryChoice } from "#/domain/projects";
import { AddProjectForm } from "../projects/add-project-form";
import {
	isUnreachableRead,
	requestJson,
	retryTransientRead,
	transientReadRetryDelay,
} from "../projects/api";
import { useGithubConnectionNotice } from "../projects/github-connection-notice";

export function ProjectPicker({
	projects,
	selectedProject,
	onSelectProject,
	open,
	onOpenChange,
}: {
	projects: Project[];
	selectedProject?: Project;
	onSelectProject: (id: string) => void;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const queryClient = useQueryClient();
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const pickerOpen = open ?? uncontrolledOpen;
	function setPickerOpen(next: boolean) {
		onOpenChange?.(next);
		if (open === undefined) setUncontrolledOpen(next);
	}
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [addingProject, setAddingProject] = useState(false);
	const [scratchName, setScratchName] = useState("");
	const [connectionNotice, dismissConnectionNotice] =
		useGithubConnectionNotice();
	const repositories = useQuery({
		queryKey: ["github", "repositories"],
		queryFn: () =>
			requestJson<{
				repositories: RepositoryChoice[];
				installationUrl: string;
			}>("/api/github/repositories"),
		// A dropped fetch (Safari "Load failed") is not a missing GitHub connection.
		retry: retryTransientRead,
		retryDelay: transientReadRetryDelay,
		// Loaded with the composer and cached, so opening the picker never waits on GitHub.
		staleTime: 5 * 60_000,
		placeholderData: keepPreviousData,
	});
	const connection = useMutation({
		mutationFn: () => requestJson<{ url: string }>("/api/github/connect", {}),
		onSuccess: ({ url }) => {
			window.location.assign(url);
		},
	});
	const save = useMutation({
		mutationFn: (repository: RepositoryChoice) =>
			requestJson<Project>("/api/projects", {
				installationId: repository.installationId,
				repositoryId: repository.repositoryId,
				branch: addedProjectBranch(repository),
			}),
		onSuccess: async (project) => {
			await queryClient.invalidateQueries({ queryKey: ["projects"] });
			onSelectProject(project.id);
			setPickerOpen(false);
			setQuery("");
		},
	});
	const create = useMutation({
		mutationFn: (name: string) =>
			requestJson<Project>("/api/github/repositories", { name }),
		onSuccess: async (project) => {
			await queryClient.invalidateQueries({ queryKey: ["projects"] });
			await queryClient.invalidateQueries({
				queryKey: ["github", "repositories"],
			});
			onSelectProject(project.id);
			setPickerOpen(false);
			setQuery("");
			setCreating(false);
			setScratchName("");
		},
	});
	const sections = useMemo(
		() =>
			projectPickerSections({
				projects,
				repositories: repositories.data?.repositories ?? [],
				query,
				selectedProjectId: selectedProject?.id,
			}),
		[projects, query, repositories.data?.repositories, selectedProject?.id],
	);
	const scratch = scratchRepositoryName(scratchName);

	function choose(row: (typeof sections.projects)[number]) {
		if (row.project) {
			onSelectProject(row.project.id);
			setPickerOpen(false);
			setQuery("");
			return;
		}
		if (row.repository) save.mutate(row.repository);
	}

	return (
		<Popover
			open={pickerOpen}
			onOpenChange={(next) => {
				setPickerOpen(next);
				if (!next) {
					dismissConnectionNotice();
					setQuery("");
					setCreating(false);
					setAddingProject(false);
					setScratchName("");
				}
			}}
		>
			<PopoverTrigger
				className="context-select project-select"
				aria-label="Project"
				title={
					selectedProject?.name || selectedProject?.fullName || "Select project"
				}
			>
				<GitBranch size={14} />
				<span>
					{selectedProject?.name ||
						selectedProject?.fullName ||
						"Select project"}
				</span>
				<ChevronDown className="size-3" />
			</PopoverTrigger>
			<PopoverContent
				side="bottom"
				align="start"
				collisionPadding={12}
				// Always opens below the trigger and scrolls within the space there.
				avoidCollisions={false}
				className="project-picker"
				data-creating={addingProject || undefined}
			>
				{addingProject ? (
					<AddProjectForm
						variant="sidebar"
						onCancel={() => setAddingProject(false)}
						onAdded={async (project) => {
							await queryClient.invalidateQueries({ queryKey: ["projects"] });
							onSelectProject(project.id);
							setAddingProject(false);
							setPickerOpen(false);
						}}
					/>
				) : (
					<>
						<label className="model-picker-search project-picker-search">
							<Search size={16} aria-hidden="true" />
							<input
								type="search"
								placeholder="Search repositories"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								aria-label="Search repositories"
							/>
						</label>
						<div
							className="project-picker-list"
							role="listbox"
							aria-label="Projects"
						>
							{sections.projects.length ? (
								<>
									<p className="project-picker-heading">Projects</p>
									{sections.projects.map((row) => (
										<PickerRow
											key={row.key}
											row={row}
											disabled={save.isPending || create.isPending}
											onChoose={() => choose(row)}
										/>
									))}
								</>
							) : null}
							<div className="project-picker-heading-row">
								<p className="project-picker-heading">GitHub repositories</p>
								<button
									type="button"
									className="project-picker-refresh"
									aria-label="Refresh repositories"
									title="Refresh repositories"
									disabled={repositories.isFetching}
									onClick={() => void repositories.refetch()}
								>
									<RefreshCw
										size={14}
										data-spinning={repositories.isFetching || undefined}
									/>
								</button>
							</div>
							{repositories.isPending ? (
								<div className="project-picker-skeleton" aria-busy="true">
									<span />
									<span />
									<span />
								</div>
							) : (
								sections.repositories.map((row) => (
									<PickerRow
										key={row.key}
										row={row}
										disabled={save.isPending || create.isPending}
										adding={
											save.isPending &&
											save.variables?.repositoryId ===
												row.repository?.repositoryId
										}
										onChoose={() => choose(row)}
									/>
								))
							)}
							{!repositories.isPending && sections.repositories.length === 0 ? (
								<p className="project-picker-empty">
									{githubRepositoryListMessage({
										query,
										loaded: Boolean(repositories.data),
										unreachable: isUnreachableRead(repositories.error),
										errorMessage: repositories.error?.message,
									})}
								</p>
							) : null}
						</div>
						{creating ? (
							<form
								className="project-picker-create"
								onSubmit={(event) => {
									event.preventDefault();
									if (scratch) create.mutate(scratch);
								}}
							>
								<input
									type="text"
									placeholder="Repository name"
									value={scratchName}
									onChange={(event) => setScratchName(event.target.value)}
									aria-label="New repository name"
								/>
								<button type="submit" disabled={!scratch || create.isPending}>
									{create.isPending ? "Creating…" : "Create"}
								</button>
								<button type="button" onClick={() => setCreating(false)}>
									Cancel
								</button>
							</form>
						) : null}
						<div className="project-picker-actions">
							{creating ? null : (
								<button type="button" onClick={() => setCreating(true)}>
									<Plus size={16} />
									New repo
								</button>
							)}
							{repositories.data?.installationUrl ? (
								<a
									href={repositories.data.installationUrl}
									target="_blank"
									rel="noreferrer"
								>
									<ExternalLink size={16} />
									Add from GitHub
								</a>
							) : isUnreachableRead(repositories.error) ? (
								<button
									type="button"
									disabled={repositories.isFetching}
									onClick={() => void repositories.refetch()}
								>
									<RefreshCw size={16} />
									{repositories.isFetching ? "Retrying…" : "Retry"}
								</button>
							) : (
								<button
									type="button"
									disabled={connection.isPending}
									onClick={() => connection.mutate()}
								>
									<ExternalLink size={16} />
									{connection.isPending ? "Opening GitHub…" : "Connect GitHub"}
								</button>
							)}
							<button type="button" onClick={() => setAddingProject(true)}>
								<Layers size={16} />
								Multi-repo
							</button>
						</div>
						{/* A failed repository list explains itself in the list above. */}
						{save.error ||
						create.error ||
						connection.error ||
						connectionNotice ? (
							<p className="project-picker-error" role="alert">
								{shownReadError(save.error) ||
									shownReadError(create.error) ||
									shownReadError(connection.error) ||
									connectionNotice}
							</p>
						) : null}
					</>
				)}
			</PopoverContent>
		</Popover>
	);
}

/** One repository row: name first, owner as secondary text, like the model picker. */
function PickerRow({
	row,
	disabled,
	adding = false,
	onChoose,
}: {
	row: { fullName: string; selected: boolean };
	disabled: boolean;
	/** The server is making this repository a project. */
	adding?: boolean;
	onChoose: () => void;
}) {
	const slash = row.fullName.indexOf("/");
	const name = slash > 0 ? row.fullName.slice(slash + 1) : row.fullName;
	const owner = slash > 0 ? row.fullName.slice(0, slash) : undefined;
	return (
		<button
			type="button"
			role="option"
			aria-selected={row.selected}
			className="project-picker-choice"
			data-selected={row.selected ? "true" : undefined}
			disabled={disabled}
			aria-busy={adding || undefined}
			onClick={onChoose}
			title={row.fullName}
		>
			<GitBranch size={16} aria-hidden="true" />
			<span className="project-picker-name">
				<strong>{name}</strong>
				{owner ? <small>{owner}</small> : null}
			</span>
			{adding ? (
				<small className="project-picker-adding">Adding…</small>
			) : row.selected ? (
				<Check size={14} aria-hidden="true" />
			) : null}
		</button>
	);
}

function shownReadError(error: Error | null | undefined) {
	if (!error) return undefined;
	return isUnreachableRead(error) ? GITHUB_LIST_UNREACHABLE : error.message;
}
