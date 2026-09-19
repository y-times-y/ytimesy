import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
	addedProjectBranch,
	addProjectCopy,
	addProjectPhase,
	filterRepositories,
} from "#/domain/add-project";
import type { Project, RepositoryChoice } from "../../domain/projects";
import { requestJson } from "./api";

export function AddProjectForm({
	variant,
	onAdded,
	onCancel,
}: {
	variant: "page" | "sidebar" | "settings";
	onAdded: (project: Project) => void;
	onCancel?: () => void;
}) {
	const [query, setQuery] = useState("");
	const [callbackFailed, setCallbackFailed] = useState(false);
	useEffect(() => {
		setCallbackFailed(
			new URLSearchParams(window.location.search).get("connection") ===
				"failed",
		);
	}, []);
	const repositories = useQuery({
		queryKey: ["github", "repositories"],
		queryFn: () =>
			requestJson<{
				repositories: RepositoryChoice[];
				installationUrl: string;
			}>("/api/github/repositories"),
		retry: false,
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
		onSuccess: onAdded,
	});
	const phase = addProjectPhase({
		loading: repositories.isPending,
		githubReady: Boolean(repositories.data),
	});
	const copy = addProjectCopy(phase);
	const visibleRepos = useMemo(
		() => filterRepositories(repositories.data?.repositories ?? [], query),
		[query, repositories.data?.repositories],
	);
	const compact = variant !== "page";
	const addingId = save.variables
		? `${save.variables.installationId}:${save.variables.repositoryId}`
		: "";

	return (
		<div
			className={
				variant === "sidebar"
					? "add-project add-project-sidebar"
					: variant === "settings"
						? "add-project add-project-settings"
						: "add-project add-project-page"
			}
		>
			{compact ? <h2>{copy.title}</h2> : null}
			<p>{copy.description}</p>
			{callbackFailed ? (
				<p role="alert">GitHub was canceled or expired. Connect it again.</p>
			) : null}
			{phase === "loading" ? <p role="status">Loading repositories…</p> : null}
			{phase === "connect" ? (
				<>
					{repositories.error ? (
						<p role="status">{repositories.error.message}</p>
					) : null}
					<button
						type="button"
						className="setup-primary"
						disabled={connection.isPending}
						onClick={() => connection.mutate()}
					>
						{connection.isPending ? "Opening GitHub…" : "Connect GitHub"}
					</button>
				</>
			) : null}
			{repositories.data ? (
				<>
					<label className="add-project-field" htmlFor="repository-search">
						Repository
					</label>
					<input
						id="repository-search"
						className="add-project-search"
						type="search"
						placeholder="Search repositories"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<ul className="add-project-repos" aria-label="Repositories">
						{visibleRepos.length === 0 ? (
							<li className="add-project-empty">
								{repositories.data.repositories.length
									? "No repositories match."
									: "No writable repositories yet."}
							</li>
						) : (
							visibleRepos.map((repo) => {
								const id = `${repo.installationId}:${repo.repositoryId}`;
								const adding = save.isPending && addingId === id;
								return (
									<li key={id}>
										<button
											type="button"
											disabled={save.isPending}
											onClick={() => save.mutate(repo)}
										>
											{adding ? "Adding…" : repo.fullName}
										</button>
									</li>
								);
							})
						)}
					</ul>
					<div className="setup-links">
						<a
							href={repositories.data.installationUrl}
							target="_blank"
							rel="noreferrer"
						>
							Manage access
						</a>
						<button
							type="button"
							onClick={() => {
								void repositories.refetch();
							}}
						>
							Refresh
						</button>
					</div>
				</>
			) : null}
			{(connection.error || save.error) && (
				<p role="alert">{connection.error?.message || save.error?.message}</p>
			)}
			{onCancel ? (
				<button type="button" className="setup-back" onClick={onCancel}>
					Cancel
				</button>
			) : null}
		</div>
	);
}
