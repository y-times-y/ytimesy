import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronRight, LockKeyhole } from "lucide-react";
import { useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { API_MODEL_LIST } from "#/domain/api-model-list";
import { AUTHOR_LABELS, visibleModelChoices } from "#/domain/browse-models";
import {
	availableConnectionModels,
	CUSTOM_SECTION,
	connectionModels,
	modelRouteId,
	type PublicModelConnection,
} from "#/domain/model-connection";
import {
	apiPickerSections,
	directKeyProvider,
	providerConnections,
	providerKeyConnection,
	selectedProviderConnection,
} from "#/domain/provider-access";
import { authClient } from "#/features/auth/client";
import {
	getBrowseModels,
	getModelConnections,
	saveModelConnectionFn,
} from "./model-connections.fn";
import { ModelProviderLogo } from "./model-provider-logo";
import { ProviderConfirmation } from "./provider-confirmation";

export function ApiModelBrowser({
	author,
	search,
	onSelect,
	onBrowseProvider,
	selectedRoute,
}: {
	author: string | null;
	search: string;
	onSelect: (route: string) => void;
	onBrowseProvider?: (author: string) => void;
	selectedRoute?: string;
}) {
	const client = useQueryClient();
	const identity = authClient.useSession();
	const browse = useServerFn(getBrowseModels);
	const load = useServerFn(getModelConnections);
	const saveConnection = useServerFn(saveModelConnectionFn);
	const [key, setKey] = useState("");
	const [chosenConnections, setChosenConnections] = useState<
		Record<string, string>
	>({});
	const catalog = useQuery({
		queryKey: ["browse-models"],
		queryFn: () => browse(),
		staleTime: 15 * 60_000,
	});
	const connections = useQuery({
		queryKey: ["model-connections"],
		queryFn: () => load(),
	});
	const available = author
		? providerConnections(author, connections.data ?? [])
		: [];
	const activeConnection = selectedProviderConnection(
		available,
		selectedRoute ?? "",
		author ? chosenConnections[author] : undefined,
	);
	const authors = author ? [author] : apiPickerSections(connections.data ?? []);
	const connected = authors.flatMap((modelAuthor) => {
		const source = author
			? activeConnection
			: selectedProviderConnection(
					providerConnections(modelAuthor, connections.data ?? []),
					selectedRoute ?? "",
				);
		return (source ? [source] : []).flatMap((connection) =>
			connectionModels(connection, catalog.data ?? [])
				.filter(
					(model) =>
						connection.provider !== "openrouter" ||
						API_MODEL_LIST.some(
							(entry) =>
								entry.openRouterId === model.id && entry.author === modelAuthor,
						),
				)
				.map((model) => ({
					...model,
					author: modelAuthor,
					connectionId: connection.id,
				})),
		);
	});
	const visibleConnected = visibleModelChoices(connected, search);
	function update(rows: PublicModelConnection[]) {
		client.setQueryData(["model-connections"], rows);
		if (identity.data?.user.id)
			client.setQueryData(
				["agent-model-catalog", identity.data.user.id, "api"],
				availableConnectionModels(rows, catalog.data ?? []),
			);
	}
	const save = useMutation({
		mutationFn: () =>
			saveConnection({ data: providerKeyConnection(author ?? "", key) }),
		onSuccess: (rows) => {
			const added = rows.find(
				(row) =>
					!(connections.data ?? []).some((current) => current.id === row.id),
			);
			if (added && author)
				setChosenConnections((current) => ({ ...current, [author]: added.id }));
			setKey("");
			update(rows);
		},
	});
	const locked = visibleModelChoices(
		API_MODEL_LIST.filter(
			(model) =>
				authors.includes(model.author) &&
				!(author
					? activeConnection
					: providerConnections(model.author, connections.data ?? []).length),
		).map((model) => ({
			id: model.openRouterId,
			label: model.label,
			author: model.author,
		})),
		search,
	);
	return (
		<>
			<h3>
				{author ? (AUTHOR_LABELS[author] ?? author) : "Models across providers"}
			</h3>
			{author && activeConnection ? (
				<div className="model-source-row">
					<span className="model-source-caption">Using</span>
					{available.length > 1 ? (
						<Select
							value={activeConnection.id}
							onValueChange={(id) =>
								setChosenConnections((current) => ({
									...current,
									[author]: id,
								}))
							}
						>
							<SelectTrigger
								className="model-source-trigger"
								aria-label={`API connection for ${AUTHOR_LABELS[author]}`}
							>
								<SelectValue>{activeConnection.label}</SelectValue>
							</SelectTrigger>
							<SelectContent
								position="popper"
								side="bottom"
								align="start"
								className="model-source-menu"
							>
								{available.map((connection) => (
									<SelectItem key={connection.id} value={connection.id}>
										{connection.label} ·{" "}
										{connection.provider === "openrouter"
											? "OpenRouter"
											: "Direct API"}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : (
						<span className="model-source-label">{activeConnection.label}</span>
					)}
				</div>
			) : null}
			{author === CUSTOM_SECTION &&
			!activeConnection &&
			!connections.isPending ? (
				<p className="model-picker-status">
					Add an OpenAI-compatible endpoint in Project settings to use its
					models here.
				</p>
			) : null}
			{author &&
			author !== CUSTOM_SECTION &&
			!activeConnection &&
			!connections.isPending ? (
				<div className="inline-model-connect provider-key-connect">
					<form
						onSubmit={(event) => {
							event.preventDefault();
							save.mutate();
						}}
					>
						<label className="inline-model-label">
							{directKeyProvider(author)
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
									placeholder="Paste API key to unlock models"
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
						{directKeyProvider(author)
							? "Provider key unlocks this provider. "
							: "Direct provider keys are not supported here yet. "}
						OpenRouter unlocks supported models across providers. Keys are
						encrypted; connecting does not run a model.
					</p>
					{save.error ? <p role="alert">{save.error.message}</p> : null}
				</div>
			) : null}
			<ProviderConfirmation
				author={author}
				connectionProvider={activeConnection?.provider}
			/>
			{visibleConnected.map((model) => {
				const route = modelRouteId(model.connectionId, model.id);
				return (
					<div
						className="model-picker-row"
						key={`${model.connectionId}:${model.id}`}
					>
						<button
							type="button"
							className="model-browser-option model-browser-choice"
							onClick={() => {
								update(connections.data ?? []);
								onSelect(route);
							}}
						>
							<ModelProviderLogo provider={model.author} />
							<span>
								{author
									? model.label
									: `${AUTHOR_LABELS[model.author] ?? model.author} · ${model.label}`}
							</span>
							<ChevronRight size={14} />
						</button>
					</div>
				);
			})}
			{author && activeConnection && !connected.length && !catalog.isPending ? (
				<p className="model-picker-status">
					No {AUTHOR_LABELS[author]} models were listed for this key.
				</p>
			) : null}
			{locked.map((model) => (
				<button
					type="button"
					className="model-browser-option"
					key={model.id}
					disabled={Boolean(author)}
					onClick={() => onBrowseProvider?.(model.author)}
					title={
						author
							? "Connect a key above to unlock models"
							: `Connect ${AUTHOR_LABELS[model.author] ?? model.author}`
					}
				>
					<ModelProviderLogo provider={model.author} />
					<span>
						{author
							? model.label
							: `${AUTHOR_LABELS[model.author] ?? model.author} · ${model.label}`}
					</span>
					<LockKeyhole size={14} />
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
			{!catalog.isPending && !locked.length && !visibleConnected.length ? (
				<p className="model-picker-status">No matching models.</p>
			) : null}
		</>
	);
}
