import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import "./model-connections.css";
import {
	availableConnectionModels,
	MODEL_PROVIDERS,
	type ModelProvider,
	modelRouteId,
	type PublicModelConnection,
} from "#/domain/model-connection";
import {
	deleteModelConnectionFn,
	getBrowseModels,
	getModelConnections,
	saveModelConnectionFn,
	verifyModelConnectionFn,
} from "./model-connections.fn";

export function ModelConnections() {
	const queryClient = useQueryClient();
	const getConnections = useServerFn(getModelConnections);
	const getCodingModels = useServerFn(getBrowseModels);
	const saveConnection = useServerFn(saveModelConnectionFn);
	const removeConnection = useServerFn(deleteModelConnectionFn);
	const verifyConnection = useServerFn(verifyModelConnectionFn);
	const connections = useQuery({
		queryKey: ["model-connections"],
		queryFn: () => getConnections(),
	});
	const codingModels = useQuery({
		queryKey: ["browse-models"],
		queryFn: () => getCodingModels(),
		staleTime: 15 * 60_000,
	});
	const [provider, setProvider] = useState<ModelProvider>("openai");
	const [label, setLabel] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [replacing, setReplacing] = useState<string>();
	const [selected, setSelected] = useState<Record<string, string>>({});
	function update(rows: PublicModelConnection[]) {
		queryClient.setQueryData(["model-connections"], rows);
	}
	const save = useMutation({
		mutationFn: () =>
			saveConnection({
				data: {
					id: replacing,
					provider,
					label: label.trim() || MODEL_PROVIDERS[provider].label,
					apiKey,
					...(provider === "compatible" ? { baseUrl } : {}),
				},
			}),
		onSuccess: (rows) => {
			update(rows);
			setApiKey("");
			setReplacing(undefined);
			setLabel("");
			setBaseUrl("");
		},
	});
	const remove = useMutation({
		mutationFn: (id: string) => removeConnection({ data: { id } }),
		onSuccess: update,
	});
	const verify = useMutation({
		mutationFn: (input: { connectionId: string; modelId: string }) =>
			verifyConnection({ data: input }),
		onSuccess: update,
	});
	const busy = save.isPending || remove.isPending || verify.isPending;
	return (
		<section aria-label="Model API connections">
			<h3>Model connections</h3>
			<p className="settings-copy">
				Add or replace keys here. Choose which saved connection to use in the
				model selector.
			</p>
			<p className="settings-copy">
				Use your own API account. Keys are encrypted, never shown again, and
				never used as a fallback for a subscription.
			</p>
			{connections.isError ? (
				<p role="alert">
					Could not load connections. Check the database migration and retry.
				</p>
			) : null}
			{connections.data?.map((connection) => {
				const visibleIds = new Set(
					availableConnectionModels([connection], codingModels.data ?? []).map(
						(row) => row.id,
					),
				);
				const visibleModels = connection.models.filter((row) =>
					visibleIds.has(modelRouteId(connection.id, row.id)),
				);
				const model = visibleModels.find(
					(row) => row.id === (selected[connection.id] ?? visibleModels[0]?.id),
				);
				return (
					<div
						className="settings-card model-connection-card"
						key={connection.id}
					>
						<strong>{connection.label}</strong>
						<p className="settings-copy">
							{MODEL_PROVIDERS[connection.provider].label} · Your API account
						</p>
						<label htmlFor={`model-${connection.id}`}>Discovered model</label>
						<select
							id={`model-${connection.id}`}
							value={model?.id ?? ""}
							onChange={(event) =>
								setSelected({
									...selected,
									[connection.id]: event.target.value,
								})
							}
						>
							{visibleModels.map((row) => (
								<option key={row.id} value={row.id}>
									{row.label}
									{row.toolStreamingVerified ? " · verified" : ""}
								</option>
							))}
						</select>
						<p className="settings-copy">
							{model?.toolStreamingVerified
								? "Streaming tool calls verified."
								: "Listing alone does not confirm coding compatibility."}{" "}
							Verification sends one small billable request to your provider.
						</p>
						<div className="model-connection-actions">
							<button
								type="button"
								className="settings-secondary"
								disabled={busy || !model}
								onClick={() =>
									model &&
									verify.mutate({
										connectionId: connection.id,
										modelId: model.id,
									})
								}
							>
								{verify.isPending &&
								verify.variables?.connectionId === connection.id
									? "Verifying…"
									: "Verify model (uses API credit)"}
							</button>
							<button
								type="button"
								className="settings-secondary"
								disabled={busy}
								onClick={() => {
									setReplacing(connection.id);
									setProvider(connection.provider);
									setLabel(connection.label);
									setBaseUrl(connection.baseUrl);
									setApiKey("");
								}}
							>
								Replace key
							</button>
							<button
								type="button"
								className="settings-secondary"
								disabled={busy}
								onClick={() => remove.mutate(connection.id)}
							>
								Disconnect
							</button>
						</div>
					</div>
				);
			})}
			<form
				className="settings-secret-form model-connection-form"
				onSubmit={(event) => {
					event.preventDefault();
					save.mutate();
				}}
			>
				<h4>
					{replacing ? "Replace connection credentials" : "Add connection"}
				</h4>
				<label htmlFor="model-provider">Provider</label>
				<select
					id="model-provider"
					value={provider}
					onChange={(event) => {
						setProvider(event.target.value as ModelProvider);
						setApiKey("");
					}}
					disabled={busy || Boolean(replacing)}
				>
					{Object.entries(MODEL_PROVIDERS).map(([id, row]) => (
						<option key={id} value={id}>
							{row.label}
						</option>
					))}
				</select>
				<label htmlFor="model-label">Connection name</label>
				<input
					id="model-label"
					maxLength={80}
					value={label}
					placeholder={MODEL_PROVIDERS[provider].label}
					onChange={(event) => setLabel(event.target.value)}
				/>
				{provider === "compatible" ? (
					<>
						<label htmlFor="model-endpoint">Public HTTPS base URL</label>
						<input
							id="model-endpoint"
							type="url"
							required
							value={baseUrl}
							placeholder="https://gateway.example.com/v1"
							onChange={(event) => setBaseUrl(event.target.value)}
						/>
					</>
				) : null}
				<label htmlFor="model-key">API key</label>
				<input
					id="model-key"
					type="password"
					required
					minLength={8}
					maxLength={4096}
					autoComplete="off"
					spellCheck={false}
					value={apiKey}
					onChange={(event) => setApiKey(event.target.value)}
				/>
				<button
					type="submit"
					className="settings-secondary"
					disabled={busy || !apiKey}
				>
					{save.isPending ? "Discovering models…" : "Save and discover models"}
				</button>
				{replacing ? (
					<button
						type="button"
						className="settings-secondary"
						onClick={() => {
							setReplacing(undefined);
							setApiKey("");
							setLabel("");
							setBaseUrl("");
						}}
					>
						Cancel replacement
					</button>
				) : null}
			</form>
			{save.error || remove.error || verify.error ? (
				<p role="alert">
					{(save.error ?? remove.error ?? verify.error)?.message}
				</p>
			) : null}
		</section>
	);
}
