import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Switch } from "#/components/ui/switch";
import { readMemoryModeFn, saveMemoryModeFn } from "./memory.fn";

const MODE_KEY = ["memory-mode"];

/** Settings, Memory: whether chats recall and save memory. */
export function MemorySettings() {
	const read = useServerFn(readMemoryModeFn);
	const save = useServerFn(saveMemoryModeFn);
	const queryClient = useQueryClient();
	const mode = useQuery({ queryKey: MODE_KEY, queryFn: () => read() });
	const change = useMutation({
		mutationFn: (on: boolean) => save({ data: { mode: on ? "full" : "off" } }),
		onSuccess: () =>
			Promise.all(
				[MODE_KEY, ["memory"], ["memory-dreams"]].map((queryKey) =>
					queryClient.invalidateQueries({ queryKey }),
				),
			),
	});
	return (
		<MemorySettingsView
			on={mode.data ? mode.data.mode !== "off" : true}
			available={mode.data?.available ?? true}
			loading={mode.isPending}
			saving={change.isPending}
			error={change.error?.message ?? mode.error?.message}
			onChange={(on) => change.mutate(on)}
		/>
	);
}

export function MemorySettingsView(props: {
	readonly on: boolean;
	readonly available: boolean;
	readonly loading?: boolean;
	readonly saving?: boolean;
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
								? "When off, nothing is recalled into chats and nothing new is saved. What is already saved stays until you delete it."
								: "This server has no memory storage configured."}
						</span>
					</div>
					<div className="settings-row-actions">
						<Switch
							id="memory-use"
							checked={props.available && props.on}
							disabled={!props.available || props.loading || props.saving}
							onCheckedChange={props.onChange}
						/>
					</div>
				</div>
			</div>
			{props.error ? <p role="alert">{props.error}</p> : null}
		</section>
	);
}
