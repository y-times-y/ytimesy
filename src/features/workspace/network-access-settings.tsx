import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RadioGroup } from "radix-ui";
import { type FormEvent, useEffect, useState } from "react";
import {
	DEFAULT_ALLOWED_DOMAINS,
	parseDomainList,
	type VmNetworkMode,
	type VmNetworkPolicy,
	vmNetworkPolicy,
} from "#/domain/vm-network-policy";
import { cacheWrite, optimisticMutation } from "#/lib/optimistic-mutation";
import { readNetworkAccessFn, saveNetworkAccessFn } from "./network-access.fn";

const MODES: { id: VmNetworkMode; name: string; description: string }[] = [
	{
		id: "full",
		name: "Full internet",
		description: "Chat machines can reach any public address.",
	},
	{
		id: "defaults",
		name: "Common dependencies",
		description:
			"Package registries, GitHub, container registries and OS mirrors, plus your domains.",
	},
	{
		id: "allowlist",
		name: "Allowlist only",
		description: "Only the domains you list below.",
	},
];

/** The saved policy shows at once; a failed save puts the old one back. */
export function networkAccessSave(
	queryClient: QueryClient,
	projectId: string,
	save: (input: {
		data: { projectId: string; policy: VmNetworkPolicy };
	}) => Promise<VmNetworkPolicy>,
) {
	const queryKey = ["project-network-access", projectId];
	return {
		mutationFn: (policy: VmNetworkPolicy) =>
			save({ data: { projectId, policy } }),
		...optimisticMutation<VmNetworkPolicy, VmNetworkPolicy>({
			queryClient,
			scope: `network-access:${projectId}`,
			writes: (policy) => [cacheWrite<VmNetworkPolicy>(queryKey, () => policy)],
			serverWrites: (data) => [{ queryKey, data }],
		}),
	};
}

export function NetworkAccessSettings({ projectId }: { projectId: string }) {
	const read = useServerFn(readNetworkAccessFn);
	const saveFn = useServerFn(saveNetworkAccessFn);
	const queryClient = useQueryClient();
	const queryKey = ["project-network-access", projectId];
	const current = useQuery({
		queryKey,
		queryFn: () => read({ data: { projectId } }),
	});
	const [mode, setMode] = useState<VmNetworkMode>("full");
	const [text, setText] = useState("");
	const [invalid, setInvalid] = useState<string | null>(null);
	useEffect(() => {
		if (!current.data) return;
		setMode(current.data.mode);
		setText(current.data.domains.join("\n"));
	}, [current.data]);
	const save = useMutation(networkAccessSave(queryClient, projectId, saveFn));
	function onSubmit(event: FormEvent) {
		event.preventDefault();
		const parsed = vmNetworkPolicy.safeParse({
			mode,
			domains: parseDomainList(text),
		});
		if (!parsed.success) {
			setInvalid(parsed.error.issues[0]?.message ?? "Invalid domains.");
			return;
		}
		setInvalid(null);
		save.mutate(parsed.data);
	}
	return (
		<section
			className="machine-size-settings"
			aria-labelledby="network-access-heading"
		>
			<div className="machine-size-heading">
				<h3 id="network-access-heading">Internet access</h3>
				<span>Per project</span>
			</div>
			<p
				className="settings-copy"
				title="Changes apply to each chat machine when its next turn starts. Cloud metadata addresses stay blocked in every mode."
			>
				What chat machines can reach.
			</p>
			{/* While the setting loads, the same form shows disabled: nothing moves when it lands. */}
			{current.data || current.isPending ? (
				<NetworkAccessView
					mode={mode}
					text={text}
					pending={!current.data}
					onMode={setMode}
					onText={setText}
					onSubmit={onSubmit}
				/>
			) : null}
			{(save.isSuccess || save.isPending) && !save.error ? (
				<p role="status" className="settings-copy">
					Saved. Applies at each chat's next turn.
				</p>
			) : null}
			{invalid || current.error || save.error ? (
				<p role="alert">{invalid ?? (current.error ?? save.error)?.message}</p>
			) : null}
		</section>
	);
}

export function NetworkAccessView({
	mode,
	text,
	pending,
	onMode,
	onText,
	onSubmit,
}: {
	mode: VmNetworkMode;
	text: string;
	pending: boolean;
	onMode: (mode: VmNetworkMode) => void;
	onText: (text: string) => void;
	onSubmit: (event: FormEvent) => void;
}) {
	const save = { isPending: pending };
	const setMode = onMode;
	const setText = onText;
	return (
		<form onSubmit={onSubmit}>
			<RadioGroup.Root
				orientation="vertical"
				className="machine-size-list"
				aria-label="Internet access"
				value={mode}
				disabled={save.isPending}
				onValueChange={(value) => {
					const next = MODES.find((row) => row.id === value);
					if (next) setMode(next.id);
				}}
			>
				{MODES.map((row) => (
					<RadioGroup.Item
						key={row.id}
						value={row.id}
						className="machine-size-option"
					>
						<span className="machine-size-choice">
							<RadioGroup.Indicator />
						</span>
						<span className="machine-size-details">
							<span className="machine-size-title">
								{row.name}
								{row.id === "full" ? (
									<span className="machine-size-default">Default</span>
								) : null}
							</span>
							<span className="machine-size-description">
								{row.description}
							</span>
						</span>
					</RadioGroup.Item>
				))}
			</RadioGroup.Root>
			{mode !== "full" ? (
				<label className="settings-copy network-domains">
					<span>Allowed domains, one per line</span>
					<textarea
						aria-label="Allowed domains"
						rows={5}
						value={text}
						spellCheck={false}
						placeholder={"api.example.com\n*.example.com"}
						onChange={(event) => setText(event.target.value)}
					/>
				</label>
			) : null}
			{mode === "defaults" ? (
				<details className="machine-size-note">
					<summary>Built-in domains ({DEFAULT_ALLOWED_DOMAINS.length})</summary>
					<p>{DEFAULT_ALLOWED_DOMAINS.join(", ")}</p>
				</details>
			) : null}
			{mode === "full" ? null : (
				<p
					className="machine-size-note"
					title="A wildcard matches one label: *.example.com covers api.example.com but not example.com. Plain HTTP, SSH and direct IP connections are blocked."
				>
					HTTPS to the listed names only.
				</p>
			)}
			<button
				type="submit"
				className="settings-secondary"
				disabled={save.isPending}
			>
				{save.isPending ? "Saving…" : "Save internet access"}
			</button>
		</form>
	);
}
