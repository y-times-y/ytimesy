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
import { SettingsSwitch } from "./settings-switch";
import { readYModeFn, saveYModeFn } from "./y-mode.fn";

export function yModeChange(
	queryClient: QueryClient,
	projectId: string,
	save: (input: {
		data: { projectId: string; enabled: boolean };
	}) => Promise<{ enabled: boolean }>,
) {
	const queryKey = ["project-y-mode", projectId];
	return {
		mutationFn: (enabled: boolean) => save({ data: { projectId, enabled } }),
		...optimisticMutation<{ enabled: boolean }, boolean>({
			queryClient,
			scope: `project-y-mode:${projectId}`,
			writes: (enabled) => [
				cacheWrite<{ enabled: boolean }>(queryKey, (current) => ({
					...current,
					enabled,
				})),
			],
			serverWrites: (data) => [{ queryKey, data }],
			// The sidebar lists the Y² chat once Y is on.
			invalidate: [["agent-sessions", projectId]],
		}),
	};
}

/** Project settings: Y for this project's chats, with a Y² chat above them (src/domain/y-agent.ts). */
export function YModeSettings({ projectId }: { projectId: string }) {
	const read = useServerFn(readYModeFn);
	const save = useServerFn(saveYModeFn);
	const queryClient = useQueryClient();
	const setting = useQuery({
		queryKey: ["project-y-mode", projectId],
		queryFn: () => read({ data: { projectId } }),
	});
	const change = useMutation(yModeChange(queryClient, projectId, save));
	const error = saveErrorMessage(change.error);
	return (
		<section className="settings-section">
			<header className="settings-section-head">
				<div>
					<h3>Y</h3>
					<p>How this project's chats work.</p>
				</div>
			</header>
			<div className="settings-group">
				<div className="settings-row">
					<div className="settings-row-text">
						<label htmlFor="project-y-mode" className="settings-row-title">
							Use Y and Y²
						</label>
						<span
							className="settings-row-meta"
							title="Each chat is Y: it hands the work to builders and keeps you posted, and builders' changes go to the chat's pull request. Y², pinned above the chats, tells you what is going on across them."
						>
							Off: each chat does the work itself.
						</span>
					</div>
					<div className="settings-row-actions">
						<SettingsSwitch
							id="project-y-mode"
							checked={setting.data?.enabled}
							onCheckedChange={(enabled) => change.mutate(enabled)}
						/>
					</div>
				</div>
			</div>
			{error ? <p role="alert">{error}</p> : null}
		</section>
	);
}
