import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import {
	describeSpec,
	formatLocal,
	type ScheduleView,
	type YSquaredSettings,
} from "#/domain/y-squared-proactive";
import {
	cacheWrite,
	optimisticMutation,
	saveErrorMessage,
} from "#/lib/optimistic-mutation";
import { SettingsSwitch } from "./settings-switch";
import {
	cancelYScheduleFn,
	readUserYDefaultFn,
	readYModeFn,
	readYProactiveFn,
	saveUserYDefaultFn,
	saveYModeFn,
	saveYProactiveFn,
} from "./y-mode.fn";

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

/** The Y² switch's wording: every chat is Y, so the setting names only Y². */
export const Y_SQUARED_SWITCH_COPY = {
	section: "Y²",
	sectionMeta: "The Super agent above this project's chats.",
	title: "Use Y²",
	description:
		"On by default. Y² stays quiet until you connect a model, and it runs only on your own plan or key. Off: each chat does the work itself.",
	hint: "Y², the Super agent, is pinned above the chats and tells you what is going on across them. Each chat is Y: it hands the work to builders and keeps you posted, and builders' changes go to the chat's pull request.",
} as const;

/** Project settings: Y² (the Super agent) for this project, pinned above its chats (src/domain/y-agent.ts). */
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
					<h3>{Y_SQUARED_SWITCH_COPY.section}</h3>
					<p>{Y_SQUARED_SWITCH_COPY.sectionMeta}</p>
				</div>
			</header>
			<div className="settings-group">
				<div className="settings-row">
					<div className="settings-row-text">
						<label htmlFor="project-y-mode" className="settings-row-title">
							{Y_SQUARED_SWITCH_COPY.title}
						</label>
						<span
							className="settings-row-meta"
							title={Y_SQUARED_SWITCH_COPY.hint}
						>
							{Y_SQUARED_SWITCH_COPY.description}
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
			<YUserDefaultSwitch />
			{setting.data?.enabled ? (
				<YProactiveSettings projectId={projectId} />
			) : null}
		</section>
	);
}

/**
 * The user-level off switch: Y² for all of this person's projects, now and
 * the ones they add later (Settings and Project settings > Y show the same).
 */
function YUserDefaultSwitch() {
	const read = useServerFn(readUserYDefaultFn);
	const save = useServerFn(saveUserYDefaultFn);
	const queryClient = useQueryClient();
	const setting = useQuery({
		queryKey: ["user-y-default"],
		queryFn: () => read(),
	});
	const change = useMutation({
		mutationFn: (enabled: boolean) => save({ data: { enabled } }),
		onSuccess: () => {
			queryClient.setQueryData(["user-y-default"], undefined);
			void queryClient.invalidateQueries({ queryKey: ["user-y-default"] });
			void queryClient.invalidateQueries({ queryKey: ["project-y-mode"] });
			void queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
		},
	});
	return (
		<div className="settings-group">
			<div className="settings-row">
				<div className="settings-row-text">
					<label htmlFor="user-y-default" className="settings-row-title">
						Y² for all my projects
					</label>
					<span className="settings-row-meta">
						Turn it off to switch Y² off for every project you have and the ones
						you add later.
					</span>
				</div>
				<div className="settings-row-actions">
					<SettingsSwitch
						id="user-y-default"
						checked={setting.data?.enabled}
						onCheckedChange={(enabled) => change.mutate(enabled)}
					/>
				</div>
			</div>
		</div>
	);
}

type ProactiveData = {
	readonly settings: YSquaredSettings;
	readonly schedules: readonly ScheduleView[];
	readonly proactiveToday: number;
	readonly proactiveLimit: number;
};

/** What Y² does on its own: stall nudges, the person's schedules and the daily wake cap. Presentational. */
export function YProactiveView({
	data,
	pending,
	onStallNudges,
	onModelChoice,
	onCancel,
}: {
	readonly data: ProactiveData;
	readonly pending: boolean;
	readonly onStallNudges: (enabled: boolean) => void;
	readonly onModelChoice: (enabled: boolean) => void;
	readonly onCancel: (id: string) => void;
}) {
	const zone = data.settings.timezone;
	return (
		<div className="settings-group" data-testid="y-proactive">
			<div className="settings-row">
				<div className="settings-row-text">
					<label htmlFor="y-stall-nudges" className="settings-row-title">
						Nudge stuck and waiting threads
					</label>
					<span className="settings-row-meta">
						Y² looks into a thread that works far longer than usual and reminds
						you once if one waits on you.
					</span>
				</div>
				<div className="settings-row-actions">
					<SettingsSwitch
						id="y-stall-nudges"
						checked={data.settings.stallNudges}
						disabled={pending}
						onCheckedChange={onStallNudges}
					/>
				</div>
			</div>
			<div className="settings-row">
				<div className="settings-row-text">
					<label htmlFor="y-model-choice" className="settings-row-title">
						Let Y² choose a thread's model
					</label>
					<span className="settings-row-meta">
						Y² may start a thread on a stronger or cheaper model and switch a
						thread's model; a model you name is used exactly. Off: Y² cannot
						choose or change models and threads use the default.
					</span>
				</div>
				<div className="settings-row-actions">
					<SettingsSwitch
						id="y-model-choice"
						checked={data.settings.modelChoice}
						disabled={pending}
						onCheckedChange={onModelChoice}
					/>
				</div>
			</div>
			<div className="settings-row">
				<div className="settings-row-text">
					<span className="settings-row-title">Proactive wakes today</span>
					<span className="settings-row-meta">
						{data.proactiveToday} of {data.proactiveLimit} (schedules and
						nudges; wakes for finished threads count separately).
					</span>
				</div>
			</div>
			<div className="settings-row">
				<div className="settings-row-text">
					<span className="settings-row-title">Schedules</span>
					<span className="settings-row-meta">
						{zone
							? `Times use ${zone}.`
							: "Times use UTC until your time zone is saved."}{" "}
						Ask Y² for one: "every weekday 9am give me a digest".
					</span>
				</div>
			</div>
			{data.schedules.length ? (
				<ul className="settings-list">
					{data.schedules.map((schedule) => (
						<li key={schedule.id} className="settings-row">
							<div className="settings-row-text">
								<span className="settings-row-title">{schedule.prompt}</span>
								<span className="settings-row-meta">
									{describeSpec(schedule.spec, schedule.timezone)}
									{schedule.nextDueAt === null
										? ""
										: ` · next ${formatLocal(schedule.nextDueAt, schedule.timezone)}`}
								</span>
							</div>
							<div className="settings-row-actions">
								<button
									type="button"
									disabled={pending}
									onClick={() => onCancel(schedule.id)}
								>
									Cancel
								</button>
							</div>
						</li>
					))}
				</ul>
			) : (
				<p className="settings-row-meta">No schedules.</p>
			)}
		</div>
	);
}

/** The browser's own time zone, saved once so schedules use it. */
const browserZone = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
	} catch {
		return null;
	}
};

function YProactiveSettings({ projectId }: { projectId: string }) {
	const read = useServerFn(readYProactiveFn);
	const save = useServerFn(saveYProactiveFn);
	const cancel = useServerFn(cancelYScheduleFn);
	const queryClient = useQueryClient();
	const queryKey = ["project-y-proactive", projectId];
	const status = useQuery({
		queryKey,
		queryFn: () => read({ data: { projectId } }),
	});
	const refresh = () => queryClient.invalidateQueries({ queryKey });
	const saveMutation = useMutation({
		mutationFn: (patch: {
			stallNudges?: boolean;
			modelChoice?: boolean;
			timezone?: string;
		}) => save({ data: { projectId, ...patch } }),
		onSuccess: refresh,
	});
	const cancelMutation = useMutation({
		mutationFn: (id: string) => cancel({ data: { projectId, id } }),
		onSuccess: refresh,
	});
	const zone = browserZone();
	const saveZone = saveMutation.mutate;
	const needsZone = Boolean(
		status.data && !status.data.settings.timezone && zone,
	);
	// Saved once, the first time the settings are opened (schedules say UTC until then).
	useEffect(() => {
		if (needsZone && zone) saveZone({ timezone: zone });
	}, [needsZone, zone, saveZone]);
	if (!status.data) return null;
	return (
		<YProactiveView
			data={status.data}
			pending={saveMutation.isPending || cancelMutation.isPending}
			onStallNudges={(stallNudges) => saveMutation.mutate({ stallNudges })}
			onModelChoice={(modelChoice) => saveMutation.mutate({ modelChoice })}
			onCancel={(id) => cancelMutation.mutate(id)}
		/>
	);
}
