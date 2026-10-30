import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import type { EnvironmentRecipe } from "#/domain/project-environment";
import { compactRelativeAge } from "#/domain/sidebar-chats";
import {
	getProjectEnvironmentFn,
	saveProjectEnvironmentFn,
} from "../projects/environment.fn";

export const environmentQueryKey = (projectId: string) =>
	["project-environment", projectId] as const;

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
						className="settings-primary environment-setup-button"
						onClick={onSetUpWithAgent}
					>
						<Sparkles size={13} />
						Set up with agent
					</button>
				) : null}
			</header>
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
										: "Not set up yet: dependencies install from the lockfile."}
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
		</dl>
	);
}

function RecipeEditor({
	projectId,
	repository,
	recipe,
	onDone,
}: {
	projectId: string;
	repository: string;
	recipe?: EnvironmentRecipe;
	onDone: () => void;
}) {
	const queryClient = useQueryClient();
	const saveFn = useServerFn(saveProjectEnvironmentFn);
	const [text, setText] = useState(() =>
		JSON.stringify(
			recipe ?? { install: "", services: [], checks: [], buildSecrets: [] },
			null,
			2,
		),
	);
	const save = useMutation({
		mutationFn: () => saveFn({ data: { projectId, repository, recipe: text } }),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: environmentQueryKey(projectId),
			});
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
