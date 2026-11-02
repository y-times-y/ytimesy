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
import { readMemoryModeFn, saveMemoryModeFn } from "./memory.fn";
import { SettingsSwitch } from "./settings-switch";

export const MODE_KEY = ["memory-mode"];

type MemoryMode = Awaited<ReturnType<typeof readMemoryModeFn>>;

/** The switch moves at once; memory and dreams refetch once the save lands. */
export function memoryModeChange(
	queryClient: QueryClient,
	save: (input: { data: { mode: "full" | "off" } }) => Promise<unknown>,
) {
	return {
		mutationFn: (on: boolean) => save({ data: { mode: on ? "full" : "off" } }),
		...optimisticMutation<unknown, boolean>({
			queryClient,
			scope: "memory-mode",
			writes: (on) => [
				cacheWrite<MemoryMode>(MODE_KEY, (current) =>
					current.available
						? { ...current, mode: on ? "full" : "off" }
						: current,
				),
			],
			invalidate: [["memory"], ["memory-dreams"]],
		}),
	};
}

/** Settings, Memory: whether chats recall and save memory. */
export function MemorySettings() {
	const read = useServerFn(readMemoryModeFn);
	const save = useServerFn(saveMemoryModeFn);
	const queryClient = useQueryClient();
	const mode = useQuery({ queryKey: MODE_KEY, queryFn: () => read() });
	const change = useMutation(memoryModeChange(queryClient, save));
	return (
		<MemorySettingsView
			on={mode.data ? mode.data.mode !== "off" : undefined}
			available={mode.data?.available ?? true}
			error={saveErrorMessage(change.error) ?? mode.error?.message}
			onChange={(on) => change.mutate(on)}
		/>
	);
}

export function MemorySettingsView(props: {
	/** Undefined until the saved mode is known: the switch shows as loading. */
	readonly on: boolean | undefined;
	readonly available: boolean;
	readonly error?: string;
	readonly onChange: (on: boolean) => void;
}) {
	return (
		<section className="settings-section">
			<header className="settings-section-head">
				<div>
					<h3>Memory</h3>
					<p>What the agent carries from one chat to the next.</p>
				</div>
			</header>
			<div className="settings-group">
				<div className="settings-row">
					<div className="settings-row-text">
						<label htmlFor="memory-use" className="settings-row-title">
							Use memory
						</label>
						<span className="settings-row-meta">
							{props.available
								? "When off, chats don't read or save memory. Your own edits still save."
								: "No memory storage on this server."}
						</span>
					</div>
					<div className="settings-row-actions">
						<SettingsSwitch
							id="memory-use"
							checked={props.available ? props.on : false}
							disabled={!props.available}
							onCheckedChange={props.onChange}
						/>
					</div>
				</div>
			</div>
			{props.error ? <p role="alert">{props.error}</p> : null}
		</section>
	);
}
