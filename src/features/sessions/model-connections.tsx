import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import "./model-connections.css";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import {
	availableConnectionModels,
	MODEL_PROVIDERS,
	type ModelProvider,
	modelRouteId,
	type PublicModelConnection,
} from "#/domain/model-connection";
import {
	cacheWrite,
	optimisticMutation,
	saveErrorMessage,
} from "#/lib/optimistic-mutation";
import {
	deleteModelConnectionFn,
	getBrowseModels,
	getModelConnections,
	saveModelConnectionFn,
	verifyModelConnectionFn,
} from "./model-connections.fn";

const CONNECTIONS_KEY = ["model-connections"];

/** A removed API key leaves the list at once. */
export function modelConnectionRemove(
	queryClient: QueryClient,
	remove: (input: { data: { id: string } }) => Promise<PublicModelConnection[]>,
) {
	return {
		mutationFn: (id: string) => remove({ data: { id } }),
		...optimisticMutation<PublicModelConnection[], string>({
			queryClient,
			scope: "model-connections",
			writes: (id) => [
				cacheWrite<PublicModelConnection[]>(CONNECTIONS_KEY, (rows) =>
					rows.filter((row) => row.id !== id),
				),
			],
			serverWrites: (data) => [{ queryKey: CONNECTIONS_KEY, data }],
		}),
	};
}

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
			setAdding(false);
			setApiKey("");
			setReplacing(undefined);
			setLabel("");
			setBaseUrl("");
		},
	});
	const remove = useMutation(
		modelConnectionRemove(queryClient, removeConnection),
	);
	const verify = useMutation({
		mutationFn: (input: { connectionId: string; modelId: string }) =>
			verifyConnection({ data: input }),
		onSuccess: update,
	});
	const busy = save.isPending || verify.isPending;
	const [adding, setAdding] = useState(false);
	const formOpen = adding || Boolean(replacing);
	function closeForm() {
		setAdding(false);
		setReplacing(undefined);
		setApiKey("");
		setLabel("");
		setBaseUrl("");
	}
	return (
		<section
			aria-label="Model API connections"
			className="settings-section settings-section-gap"
		>
			<header className="settings-section-head">
				<div>
					<h3>API keys</h3>
					<p title="Keys are encrypted and never shown again. A key stands in for a subscription only during an outage, when automatic failover (below) is on.">
						Use your own model provider account.
					</p>
				</div>
				{formOpen ? null : (
					<button
						type="button"
						className="settings-secondary"
						onClick={() => setAdding(true)}
					>
						Add API key
					</button>
				)}
			</header>
			{connections.isError ? (
				<p role="alert">Could not load your API keys. Please retry.</p>
			) : null}
			{connections.data?.length ? (
				<ul className="settings-group">
					{connections.data.map((connection) => {
						const visibleIds = new Set(
							availableConnectionModels(
								[connection],
								codingModels.data ?? [],
							).map((row) => row.id),
						);
						const visibleModels = connection.models.filter((row) =>
							visibleIds.has(modelRouteId(connection.id, row.id)),
						);
						const model = visibleModels.find(
							(row) =>
								row.id === (selected[connection.id] ?? visibleModels[0]?.id),
						);
						return (
							<li key={connection.id} className="model-connection-item">
								<div className="settings-row">
									<div className="settings-row-text">
										<span className="settings-row-title">
											{connection.label}
										</span>
										<span className="settings-row-meta">
											{MODEL_PROVIDERS[connection.provider].label} ·{" "}
											{visibleModels.length} coding models
										</span>
									</div>
									<div className="settings-row-actions">
										<button
											type="button"
											className="settings-secondary"
											disabled={busy}
											onClick={() => {
												setAdding(false);
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
											Remove
										</button>
									</div>
								</div>
								{visibleModels.length ? (
									<div className="model-connection-verify">
										<Select
											value={model?.id ?? ""}
											onValueChange={(value) =>
												setSelected({ ...selected, [connection.id]: value })
											}
										>
											<SelectTrigger
												className="model-connection-select"
												aria-label={`Model for ${connection.label}`}
											>
												<SelectValue placeholder="Choose a model" />
											</SelectTrigger>
											<SelectContent>
												{visibleModels.map((row) => (
													<SelectItem key={row.id} value={row.id}>
														{row.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										{model?.toolStreamingVerified ? (
											<span className="settings-badge" data-tone="ok">
												Tools verified
											</span>
										) : (
											<button
												type="button"
												className="settings-secondary"
												disabled={busy || !model}
												title="Sends one small billable request to your provider"
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
													? "Checking…"
													: "Check tool support"}
											</button>
										)}
									</div>
								) : null}
							</li>
						);
					})}
				</ul>
			) : connections.data && !formOpen ? (
				<div className="settings-group settings-empty">No API keys yet.</div>
			) : null}
			{formOpen ? (
				<form
					className="settings-group settings-form-grid"
					onSubmit={(event) => {
						event.preventDefault();
						save.mutate();
					}}
				>
					<div className="settings-field">
						<span>Provider</span>
						<Select
							value={provider}
							disabled={busy || Boolean(replacing)}
							onValueChange={(value) => {
								setProvider(value as ModelProvider);
								setApiKey("");
							}}
						>
							<SelectTrigger aria-label="Provider">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(MODEL_PROVIDERS).map(([id, row]) => (
									<SelectItem key={id} value={id}>
										{row.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<label className="settings-field">
						<span>Name</span>
						<input
							maxLength={80}
							value={label}
							placeholder={MODEL_PROVIDERS[provider].label}
							onChange={(event) => setLabel(event.target.value)}
						/>
					</label>
					{provider === "compatible" ? (
						<label className="settings-field settings-field-wide">
							<span>Public HTTPS base URL</span>
							<input
								type="url"
								required
								value={baseUrl}
								placeholder="https://gateway.example.com/v1"
								onChange={(event) => setBaseUrl(event.target.value)}
							/>
							<small className="settings-field-hint">
								Your gateway or self-hosted models. Every model it lists appears
								under Custom in the model picker.
							</small>
						</label>
					) : null}
					<label className="settings-field settings-field-wide">
						<span>API key</span>
						<input
							type="password"
							required
							minLength={8}
							maxLength={4096}
							autoComplete="off"
							spellCheck={false}
							value={apiKey}
							onChange={(event) => setApiKey(event.target.value)}
						/>
					</label>
					<div className="settings-form-actions">
						<button
							type="button"
							className="settings-secondary"
							onClick={closeForm}
						>
							Cancel
						</button>
						<button
							type="submit"
							className="settings-primary"
							disabled={busy || !apiKey}
						>
							{save.isPending
								? "Finding models…"
								: replacing
									? "Replace key"
									: "Save key"}
						</button>
					</div>
				</form>
			) : null}
			{save.error || remove.error || verify.error ? (
				<p role="alert">
					{saveErrorMessage(save.error ?? remove.error ?? verify.error)}
				</p>
			) : null}
		</section>
	);
}
