import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CircleDashed, LoaderCircle } from "lucide-react";
import { useState } from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "#/components/ui/tooltip";
import {
	detectedSetupLine,
	type RepositorySetup,
} from "#/domain/environment-detection";
import { RERUN_SETUP_LABEL } from "#/domain/environment-setup";
import {
	type EnvironmentRecipe,
	unverifiedItemDetails,
} from "#/domain/project-environment";
import { compactRelativeAge } from "#/domain/sidebar-chats";
import {
	getProjectEnvironmentFn,
	restoreProjectEnvironmentFn,
	saveProjectEnvironmentFn,
} from "../projects/environment.fn";
import {
	EnvironmentBuildFailureDetail,
	EnvironmentBuildSteps,
	useEnvironmentProgress,
} from "../projects/environment-build-progress";
import {
	retryWorkspace,
	workspaceStatusIsLive,
	workspaceStatusQuery,
} from "../projects/workspace-status";

export const environmentQueryKey = (projectId: string) =>
	["project-environment", projectId] as const;

/** The setup button's tooltip: what pressing it does, in one line. */
export const ENVIRONMENT_SETUP_BUTTON_TITLE =
	"Runs project setup again in a new chat: the agent checks install, build and tests, then saves the setup here.";

const SOURCE = {
	agent: "Set up by the agent",
	user: "Edited by you",
	import: "Imported",
};

/**
 * Settings > Project > Environment: how each repository's machine is set up
 * (saved here, ahead of a repository's own .ytimesy/environment.json), with
 * the agent setup, a hand edit and the history.
 */
export function EnvironmentSettings({
	projectId,
	onSetUpWithAgent,
}: {
	projectId: string;
	onSetUpWithAgent?: () => void;
}) {
	const read = useServerFn(getProjectEnvironmentFn);
	const environment = useQuery({
		queryKey: environmentQueryKey(projectId),
		queryFn: () => read({ data: { projectId } }),
	});
	const [editing, setEditing] = useState<string | null>(null);
	const [showHistory, setShowHistory] = useState(false);
	// The setup each repository uses now has nothing to restore.
	const latestIds = new Set(
		environment.data?.repositories.flatMap((repo) =>
			repo.saved ? [repo.saved.id] : [],
		) ?? [],
	);
	return (
		<section className="settings-section">
			<header className="settings-section-head">
				<div>
					<h3>Environment</h3>
					<p>How each new chat's machine is set up.</p>
				</div>
				{onSetUpWithAgent ? (
					<button
						type="button"
						className="settings-secondary environment-setup-button"
						title={ENVIRONMENT_SETUP_BUTTON_TITLE}
						onClick={onSetUpWithAgent}
					>
						{RERUN_SETUP_LABEL}
					</button>
				) : null}
			</header>
			<LastBuild projectId={projectId} />
			{environment.isPending ? (
				<p className="settings-copy">Loading…</p>
			) : environment.error ? (
				<p role="alert">{environment.error.message}</p>
			) : (
				environment.data.repositories.map((repo) => (
					<div key={repo.repositoryId} className="settings-group">
						<div className="settings-row">
							<div className="settings-row-text">
								<span className="settings-row-title">{repo.fullName}</span>
								<span className="settings-row-meta">
									{repo.saved
										? `${SOURCE[repo.saved.source]} · ${savedAgo(repo.saved.savedAt)}`
										: detectedSetupLine(repo.setup)}
								</span>
							</div>
							<div className="settings-row-actions">
								<button
									type="button"
									className="settings-secondary"
									onClick={() =>
										setEditing(editing === repo.fullName ? null : repo.fullName)
									}
								>
									{editing === repo.fullName ? "Close" : "Edit"}
								</button>
							</div>
						</div>
						{editing === repo.fullName ? (
							<RecipeEditor
								projectId={projectId}
								repository={repo.fullName}
								recipe={repo.saved?.recipe}
								setup={repo.setup}
								onDone={() => setEditing(null)}
							/>
						) : repo.saved ? (
							<RecipeSummary recipe={repo.saved.recipe} />
						) : null}
					</div>
				))
			)}
			{environment.data?.history.length ? (
				<>
					<button
						type="button"
						className="list-fold-toggle"
						onClick={() => setShowHistory((open) => !open)}
					>
						{showHistory
							? "Hide history"
							: `History (${environment.data.history.length})`}
					</button>
					{showHistory ? (
						<ul className="settings-group">
							{environment.data.history.map((row) => (
								<li key={row.id} className="settings-row">
									<div className="settings-row-text">
										<span className="settings-row-title">
											{row.summary || SOURCE[row.source]}
										</span>
										<span className="settings-row-meta">
											{row.fullName} · {SOURCE[row.source]} ·{" "}
											{new Date(row.savedAt).toLocaleString()}
										</span>
									</div>
									{latestIds.has(row.id) ? null : (
										<div className="settings-row-actions">
											<RestoreButton projectId={projectId} recipeId={row.id} />
										</div>
									)}
								</li>
							))}
						</ul>
					) : null}
				</>
			) : null}
		</section>
	);
}

function savedAgo(savedAt: string) {
	const age = compactRelativeAge(savedAt, Date.now());
	return !age || age === "now" ? "just now" : `${age} ago`;
}

function RecipeSummary({ recipe }: { recipe: EnvironmentRecipe }) {
	const rows = [
		recipe.install ? ["Install", [recipe.install]] : null,
		recipe.services.length
			? [
					"Services",
					recipe.services.map(
						(service) =>
							`${service.name}: ${service.command} (port ${service.port})`,
					),
				]
			: null,
		[...recipe.verify, ...recipe.checks].length
			? ["Checks", [...new Set([...recipe.verify, ...recipe.checks])]]
			: null,
		recipe.buildSecrets.length
			? ["Secrets", [recipe.buildSecrets.join(", ")]]
			: null,
	].filter(Boolean) as [string, string[]][];
	const unverified = recipe.unverified ?? [];
	return (
		<dl className="environment-recipe">
			{rows.map(([label, values]) => (
				<div key={label}>
					<dt>{label}</dt>
					<dd>
						{values.map((value) => (
							<code key={value}>{value}</code>
						))}
					</dd>
				</div>
			))}
			{unverified.length ? (
				<div>
					<dt>Unverified</dt>
					<dd>
						<TooltipProvider>
							{unverified.map((item) => (
								<Tooltip key={item.what}>
									<TooltipTrigger
										type="button"
										className="environment-unverified"
									>
										<CircleDashed aria-hidden="true" size={12} />
										<span>{item.what}</span>
									</TooltipTrigger>
									<TooltipContent side="bottom" align="start" sideOffset={6}>
										{unverifiedItemDetails(item)}
									</TooltipContent>
								</Tooltip>
							))}
						</TooltipProvider>
					</dd>
				</div>
			) : null}
		</dl>
	);
}

/**
 * What the Edit box starts with: the saved setup, or a valid one from what
 * the active build detected (its install, when there was one).
 */
export function editorStartingRecipe(
	recipe: EnvironmentRecipe | undefined,
	setup: RepositorySetup | null | undefined,
) {
	if (recipe) return recipe;
	const install =
		setup?.source === "detected" && setup.install ? setup.install : undefined;
	return {
		...(install ? { install } : {}),
		checks: [],
		services: [],
		buildSecrets: [],
	} satisfies Partial<EnvironmentRecipe>;
}

function RecipeEditor({
	projectId,
	repository,
	recipe,
	setup,
	onDone,
}: {
	projectId: string;
	repository: string;
	recipe?: EnvironmentRecipe;
	setup?: RepositorySetup | null;
	onDone: () => void;
}) {
	const queryClient = useQueryClient();
	const saveFn = useServerFn(saveProjectEnvironmentFn);
	const [text, setText] = useState(() =>
		JSON.stringify(editorStartingRecipe(recipe, setup), null, 2),
	);
	const save = useMutation({
		mutationFn: () => saveFn({ data: { projectId, repository, recipe: text } }),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: environmentQueryKey(projectId),
				}),
				queryClient.invalidateQueries({
					queryKey: workspaceStatusQuery(projectId).queryKey,
				}),
			]);
			onDone();
		},
	});
	return (
		<div className="settings-group-body environment-editor">
			<textarea
				aria-label={`Environment setup for ${repository}`}
				value={text}
				spellCheck={false}
				rows={12}
				onChange={(event) => setText(event.target.value)}
			/>
			{save.error ? <p role="alert">{save.error.message}</p> : null}
			<div className="settings-form-actions">
				<button
					type="button"
					className="settings-primary"
					disabled={save.isPending}
					onClick={() => save.mutate()}
				>
					{save.isPending ? "Saving…" : "Save and rebuild"}
				</button>
			</div>
		</div>
	);
}

/** Saves an older setup again as the newest one; the project rebuilds from it. */
function RestoreButton({
	projectId,
	recipeId,
}: {
	projectId: string;
	recipeId: string;
}) {
	const queryClient = useQueryClient();
	const restoreFn = useServerFn(restoreProjectEnvironmentFn);
	const restore = useMutation({
		mutationFn: () => restoreFn({ data: { projectId, recipeId } }),
		onSuccess: () =>
			Promise.all([
				queryClient.invalidateQueries({
					queryKey: environmentQueryKey(projectId),
				}),
				queryClient.invalidateQueries({
					queryKey: workspaceStatusQuery(projectId).queryKey,
				}),
			]),
	});
	return (
		<button
			type="button"
			className="settings-secondary"
			disabled={restore.isPending}
			title={restore.error?.message}
			onClick={() => restore.mutate()}
		>
			{restore.isPending ? "Restoring…" : "Restore"}
		</button>
	);
}

/**
 * The environment's last build: when it finished, a rebuild running (with
 * its live steps on request), or why the last one failed, with Retry.
 */
function LastBuild({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();
	const workspace = useQuery({
		...workspaceStatusQuery(projectId),
		refetchInterval: (query) =>
			workspaceStatusIsLive(query.state.data) ? 3000 : false,
	});
	const [showSteps, setShowSteps] = useState(false);
	const build = workspace.data?.build ?? null;
	const progress = useEnvironmentProgress(projectId, {
		enabled: showSteps && build?.status === "running",
	});
	const retry = useMutation({
		mutationFn: () => {
			const current = workspace.data;
			if (!current) throw new Error("The project is still loading.");
			return retryWorkspace({
				workspaceId: current.id,
				mode: current.status === "ready" ? "rebuild" : "retry",
			});
		},
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: workspaceStatusQuery(projectId).queryKey,
			}),
	});
	if (!workspace.data || !build) return null;
	const age = (at: string | null) => (at ? savedAgo(at) : "");
	return (
		<div className="settings-group">
			<div className="settings-row">
				<div className="settings-row-text">
					<span className="settings-row-title">
						{build.status === "running" ? (
							<>
								<LoaderCircle size={12} className="workspace-status-spin" />{" "}
								{build.rebuild ? "Rebuilding…" : "Setting up…"}
							</>
						) : build.status === "ready" ? (
							"Environment ready"
						) : build.rebuild ? (
							"Last rebuild failed · still using the previous setup"
						) : (
							"Setup failed"
						)}
					</span>
					<span className="settings-row-meta">
						{build.status === "running"
							? `Started ${age(build.startedAt)}`
							: `${build.status === "ready" ? "Built" : "Failed"} ${age(build.completedAt)}`}
					</span>
				</div>
				<div className="settings-row-actions">
					{build.status === "running" ? (
						<button
							type="button"
							className="settings-secondary"
							onClick={() => setShowSteps((open) => !open)}
						>
							{showSteps ? "Hide" : "Details"}
						</button>
					) : build.status === "failed" ? (
						<button
							type="button"
							className="settings-secondary"
							disabled={retry.isPending}
							onClick={() => retry.mutate()}
						>
							{retry.isPending ? "Retrying…" : "Retry"}
						</button>
					) : null}
				</div>
			</div>
			{build.status === "running" && showSteps ? (
				<div className="settings-group-body">
					<EnvironmentBuildSteps steps={progress.data?.steps ?? []} />
				</div>
			) : null}
			{build.status === "failed" ? (
				<div className="settings-group-body">
					<EnvironmentBuildFailureDetail
						failure={build.failure}
						message={build.errorMessage}
					/>
				</div>
			) : null}
			{retry.error ? <p role="alert">{retry.error.message}</p> : null}
		</div>
	);
}
