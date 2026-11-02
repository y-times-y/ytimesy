import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronRight, LockKeyhole } from "lucide-react";
import { type ReactNode, useState } from "react";
import { MenuSelect } from "#/components/ui/menu-select";
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
	coveredIds,
	hasOtherResults = false,
	source,
	usage,
}: {
	author: string | null;
	search: string;
	onSelect: (route: string) => void;
	onBrowseProvider?: (author: string) => void;
	selectedRoute?: string;
	/** Models another usable route already lists (the Claude subscription): no locked copy. */
	coveredIds?: readonly string[];
	/** Search found models above this list, so an empty list says nothing. */
	hasOtherResults?: boolean;
	/** "plan": only the provider's subscription (Grok's own rail entry); "keys": only API keys. */
	source?: "plan" | "keys";
	/** The plan's usage line, under its caption (Grok's own rail entry). */
	usage?: ReactNode;
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
		? providerConnections(author, connections.data ?? []).filter(
				(connection) =>
					!source || (source === "plan") === Boolean(connection.subscription),
			)
		: [];
	const plan = source === "plan";
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
				!plan &&
				authors.includes(model.author) &&
				!coveredIds?.includes(model.openRouterId) &&
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
	if (!author && hasOtherResults && !locked.length && !visibleConnected.length)
		return null;
	return (
		<>
			<h3>
				{plan && author === "x-ai"
					? "Grok"
					: author
						? (AUTHOR_LABELS[author] ?? author)
						: "Models across providers"}
			</h3>
			{plan ? (
				<p className="model-browser-caption">
					{activeConnection
						? "Grok subscription"
						: "Connect your Grok plan in Settings › Agents"}
				</p>
			) : null}
			{plan && activeConnection ? usage : null}
			{author && activeConnection && !plan ? (
				<div className="model-source-row">
					<span className="model-source-caption">Using</span>
					{available.length > 1 ? (
						<MenuSelect
							value={activeConnection.id}
							onValueChange={(id) =>
								setChosenConnections((current) => ({
									...current,
									[author]: id,
								}))
							}
							valueLabel={activeConnection.label}
							options={available.map((connection) => ({
								value: connection.id,
								label: `${connection.label} · ${
									connection.subscription
										? "Subscription"
										: connection.provider === "openrouter"
											? "OpenRouter"
											: "Direct API"
								}`,
							}))}
							className="model-source-trigger"
							menuClassName="model-source-menu"
							aria-label={`API connection for ${AUTHOR_LABELS[author]}`}
						/>
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
			!plan &&
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
				const chosen = plan && route === selectedRoute;
				return (
					<div
						className="model-picker-row"
						key={`${model.connectionId}:${model.id}`}
						data-selected={plan ? chosen : undefined}
					>
						<button
							type="button"
							className="model-browser-option model-browser-choice"
							onClick={() => {
								update(connections.data ?? []);
								onSelect(route);
							}}
						>
							<ModelProviderLogo provider={model.author} size={16} />
							<span>
								{author
									? model.label
									: `${AUTHOR_LABELS[model.author] ?? model.author} · ${model.label}`}
							</span>
							{plan ? (
								chosen ? (
									<Check size={14} aria-hidden="true" />
								) : null
							) : (
								<ChevronRight size={14} />
							)}
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
					<ModelProviderLogo provider={model.author} size={16} />
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
