import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	cacheWrite,
	optimisticMutation,
	saveErrorMessage,
} from "#/lib/optimistic-mutation";
import {
	readDefaultBranchPushFn,
	saveDefaultBranchPushFn,
} from "./default-branch-push.fn";
import { SettingsSwitch } from "./settings-switch";

export function defaultBranchPushChange(
	queryClient: QueryClient,
	projectId: string,
	save: (input: {
		data: { projectId: string; allowed: boolean };
	}) => Promise<{ allowed: boolean }>,
) {
	const queryKey = ["project-default-branch-push", projectId];
	return {
		mutationFn: (allowed: boolean) => save({ data: { projectId, allowed } }),
		...optimisticMutation<{ allowed: boolean }, boolean>({
			queryClient,
			scope: `project-default-branch-push:${projectId}`,
			writes: (allowed) => [
				cacheWrite<{ allowed: boolean }>(queryKey, (current) => ({
					...current,
					allowed,
				})),
			],
			serverWrites: (data) => [{ queryKey, data }],
		}),
	};
}

export function DefaultBranchPushSettings({
	projectId,
	branch,
}: {
	projectId: string;
	/** The project's default branch, for the label. */
	branch: string;
}) {
	const read = useServerFn(readDefaultBranchPushFn);
	const save = useServerFn(saveDefaultBranchPushFn);
	const queryClient = useQueryClient();
	const setting = useQuery({
		queryKey: ["project-default-branch-push", projectId],
		queryFn: () => read({ data: { projectId } }),
	});
	const change = useMutation(
		defaultBranchPushChange(queryClient, projectId, save),
	);
	const error = saveErrorMessage(change.error);
	return (
		<section className="settings-section">
			<header className="settings-section-head">
				<div>
					<h3>Git</h3>
					<p>How agents push.</p>
				</div>
			</header>
			<div className="settings-group">
				<div className="settings-row">
					<div className="settings-row-text">
						<label
							htmlFor="project-default-branch-push"
							className="settings-row-title"
						>
							Allow pushes to {branch} without asking
						</label>
						<span
							className="settings-row-meta"
							title={`The agent can push to ${branch} without your approval. Off: it works on its own branch and asks before pushing to ${branch}.`}
						>
							Off: the agent asks first.
						</span>
					</div>
					<div className="settings-row-actions">
						<SettingsSwitch
							id="project-default-branch-push"
							checked={setting.data?.allowed}
							onCheckedChange={(allowed) => change.mutate(allowed)}
						/>
					</div>
				</div>
			</div>
			{error ? <p role="alert">{error}</p> : null}
		</section>
	);
}
