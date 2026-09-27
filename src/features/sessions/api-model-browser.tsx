import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronRight, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { AUTHOR_LABELS, directModelProvider } from "#/domain/browse-models";
import {
	modelRouteId,
	type PublicModelConnection,
	verifiedConnectionModels,
} from "#/domain/model-connection";
import {
	providerConnections,
	providerKeyConnection,
} from "#/domain/provider-access";
import { authClient } from "#/features/auth/client";
import {
	getBrowseModels,
	getModelConnections,
	saveModelConnectionFn,
	verifyModelConnectionFn,
} from "./model-connections.fn";
import { ModelProviderLogo } from "./model-provider-logo";

export function ApiModelBrowser({
	author,
	search,
	onSelect,
}: {
	author: string;
	search: string;
	onSelect: (route: string) => void;
}) {
	const client = useQueryClient();
	const identity = authClient.useSession();
	const browse = useServerFn(getBrowseModels);
	const load = useServerFn(getModelConnections);
	const saveConnection = useServerFn(saveModelConnectionFn);
	const verifyConnection = useServerFn(verifyModelConnectionFn);
	const [key, setKey] = useState("");
	const [selected, setSelected] = useState<{
		connectionId: string;
		modelId: string;
		label: string;
	} | null>(null);
	const catalog = useQuery({
		queryKey: ["browse-models"],
		queryFn: () => browse(),
		staleTime: 15 * 60_000,
	});
	const connections = useQuery({
		queryKey: ["model-connections"],
		queryFn: () => load(),
	});
	const available = providerConnections(author, connections.data ?? []);
	const connected = available.flatMap((connection) =>
		connection.models
			.filter(
				(model) =>
					connection.provider !== "openrouter" ||
					model.id.startsWith(`${author}/`),
			)
			.map((model) => ({
				...model,
				connectionId: connection.id,
				connectionLabel: connection.label,
			})),
	);
	const matchesSearch = (label: string) =>
		label.toLowerCase().includes(search.trim().toLowerCase());
	function update(rows: PublicModelConnection[]) {
		client.setQueryData(["model-connections"], rows);
		if (identity.data?.user.id)
			client.setQueryData(
				["agent-model-catalog", identity.data.user.id, "api"],
				verifiedConnectionModels(rows),
			);
	}
	const save = useMutation({
		mutationFn: () =>
			saveConnection({ data: providerKeyConnection(author, key) }),
		onSuccess: (rows) => {
			setKey("");
			setSelected(null);
			update(rows);
		},
	});
	const verify = useMutation({
		mutationFn: () => {
			if (!selected) throw new Error("Select a model first.");
			return verifyConnection({
				data: {
					connectionId: selected.connectionId,
					modelId: selected.modelId,
				},
			});
		},
		onSuccess: (rows) => {
			update(rows);
			if (selected)
				onSelect(modelRouteId(selected.connectionId, selected.modelId));
		},
	});
	const locked = connected.length
		? []
		: (catalog.data ?? []).filter(
				(model) => model.author === author && matchesSearch(model.label),
			);
	return (
		<>
			<h3>{AUTHOR_LABELS[author]}</h3>
			<div className="inline-model-connect provider-key-connect">
				{available.length ? (
					<p className="provider-connected" role="status">
						<Check size={13} /> Connected ·{" "}
						{Array.from(new Set(available.map((row) => row.label))).join(", ")}
					</p>
				) : null}
				<form
					onSubmit={(event) => {
						event.preventDefault();
						save.mutate();
					}}
				>
					<label className="inline-model-label">
						{directModelProvider(author)
							? `${AUTHOR_LABELS[author]} API key or OpenRouter key`
							: "OpenRouter key"}
						<div className="provider-key-row">
							<input
								aria-label="Provider API key or OpenRouter key"
								type="password"
								autoComplete="off"
								spellCheck={false}
								required
								minLength={8}
								maxLength={4096}
								value={key}
								onChange={(event) => setKey(event.target.value)}
								placeholder={
									available.length
										? "Connect another key"
										: "Paste API key to unlock models"
								}
								disabled={save.isPending}
							/>
							<button
								className="model-connect-primary"
								type="submit"
								disabled={save.isPending || !key.trim()}
							>
								{save.isPending ? "Connecting…" : "Connect"}
							</button>
						</div>
					</label>
				</form>
				<p>
					{directModelProvider(author)
						? "Provider key unlocks this provider. "
						: "Direct provider keys are not supported here yet. "}
					OpenRouter unlocks supported models across providers. Keys are
					encrypted; connecting does not run a model.
				</p>
				{save.error ? <p role="alert">{save.error.message}</p> : null}
			</div>
			{selected ? (
				<div className="inline-model-connect provider-model-check">
					<strong>{selected.label}</strong>
					<p>
						First use checks streaming and tool support with one small paid
						request.
					</p>
					<button
						className="model-connect-primary"
						type="button"
						disabled={verify.isPending}
						onClick={() => verify.mutate()}
					>
						{verify.isPending
							? "Checking model…"
							: "Verify & use · uses API credit"}
					</button>
					{verify.error ? <p role="alert">{verify.error.message}</p> : null}
				</div>
			) : null}
			{connected
				.filter((model) => matchesSearch(model.label))
				.map((model) => (
					<button
						type="button"
						className="model-browser-option"
						key={`${model.connectionId}:${model.id}`}
						disabled={verify.isPending}
						onClick={() => {
							verify.reset();
							if (model.toolStreamingVerified) {
								update(connections.data ?? []);
								onSelect(modelRouteId(model.connectionId, model.id));
							} else
								setSelected({
									connectionId: model.connectionId,
									modelId: model.id,
									label: model.label,
								});
						}}
					>
						<ModelProviderLogo provider={author} />
						<span>
							{model.label}
							<small>{model.connectionLabel}</small>
						</span>
						<ChevronRight size={14} />
					</button>
				))}
			{locked.map((model) => (
				<button
					type="button"
					className="model-browser-option"
					key={model.id}
					disabled
					title="Connect a key above to unlock models"
				>
					<ModelProviderLogo provider={author} />
					<span>{model.label}</span>
					<LockKeyhole size={13} />
				</button>
			))}
			{connections.isError ? (
				<p role="alert">
					Could not load connections.{" "}
					<button type="button" onClick={() => void connections.refetch()}>
						Retry
					</button>
				</p>
			) : null}
			{!connected.length && catalog.isError ? (
				<p role="alert">
					Model catalog unavailable.{" "}
					<button type="button" onClick={() => void catalog.refetch()}>
						Retry
					</button>
				</p>
			) : null}
			{!connected.length && catalog.isPending ? (
				<p className="model-picker-status">Getting the model catalog…</p>
			) : null}
			{!catalog.isPending &&
			!locked.length &&
			!connected.some((model) => matchesSearch(model.label)) ? (
				<p className="model-picker-status">No matching models.</p>
			) : null}
		</>
	);
}
