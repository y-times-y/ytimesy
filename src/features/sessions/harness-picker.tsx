import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronDown, Search, Star, Zap } from "lucide-react";
import "./model-picker.css";
import { type ReactNode, useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import {
	type AgentProviderId,
	offeredAgentProviders,
} from "#/domain/agent-provider";
import { AUTHOR_LABELS, recentModelGenerations } from "#/domain/browse-models";
import { parseModelRouteId } from "#/domain/model-connection";
import { apiPickerSections } from "#/domain/provider-access";
import { authClient } from "#/features/auth/client";
import {
	ModelPickerUsage,
	useCloudUsageWindows,
} from "../workspace/usage-windows";
import { AgentProviderMark } from "./agent-provider-mark";
import { ApiModelBrowser } from "./api-model-browser";
import {
	type ComposerSpeed,
	type SessionModel,
	sessionModelsFromListed,
} from "./model-capabilities";
import { getAgentModelCatalog } from "./model-catalog.fn";
import { getModelConnections } from "./model-connections.fn";
import {
	favoriteModelKey,
	readModelFavorites,
	writeModelFavorites,
} from "./model-picker-favorites";
import { ModelPickerSettings } from "./model-picker-settings";
import { ModelProviderLogo } from "./model-provider-logo";
import {
	ModelPickerPlanUsage,
	usePlanUsageBars,
	usePrefetchPlanUsage,
} from "./plan-usage";

/** The composer's model button; Cmd+Shift+M clicks it. */
export const MODEL_PICKER_ID = "session-harness-select";

/** API maker sections; mounted only while the picker is open. */
function ApiProviderRail({
	selected,
	onSelect,
}: {
	selected: string | null;
	onSelect: (id: string) => void;
}) {
	const loadConnections = useServerFn(getModelConnections);
	const connections = useQuery({
		queryKey: ["model-connections"],
		queryFn: () => loadConnections(),
	});
	return apiPickerSections(connections.data ?? [])
		.map((id) => [id, AUTHOR_LABELS[id] ?? id] as const)
		.map(([id, label]) => (
			<button
				type="button"
				key={id}
				title={label}
				aria-label={label}
				aria-pressed={selected === id}
				onClick={() => onSelect(id)}
			>
				<ModelProviderLogo provider={id} size={21} />
			</button>
		));
}

export function HarnessPicker({
	connectionContent,
	harnessId,
	onHarnessIdChange,
	models,
	modelId,
	onModelIdChange,
	modelsEnabled,
	onConnect,
	catalogStatus = "ready",
	providerConnected = false,
	reasoningId = "",
	onReasoningIdChange,
	speed = "",
	onSpeedChange,
}: {
	connectionContent?: ReactNode;
	harnessId: AgentProviderId;
	onHarnessIdChange: (id: AgentProviderId) => void;
	models: readonly SessionModel[];
	modelId: string;
	onModelIdChange: (id: string) => void;
	modelsEnabled: boolean;
	onConnect?: () => void;
	catalogStatus?: "loading" | "error" | "ready";
	providerConnected?: boolean;
	reasoningId?: string;
	onReasoningIdChange?: (id: string) => void;
	speed?: ComposerSpeed;
	onSpeedChange?: (speed: ComposerSpeed) => void;
}) {
	const options = offeredAgentProviders();
	const selected =
		options.find((option) => option.id === harnessId) ?? options[0];
	const [open, setOpen] = useState(false);
	// Read with the composer, so the picker opens at its full height.
	const usageWindows = useCloudUsageWindows();
	const planBars = usePlanUsageBars(open);
	const prefetchPlanUsage = usePrefetchPlanUsage();
	const [browse, setBrowse] = useState(harnessId === "api");
	const [apiProvider, setApiProvider] = useState("openai");
	const [search, setSearch] = useState("");
	const [favoritesOnly, setFavoritesOnly] = useState(false);
	const [favorites, setFavorites] = useState<readonly string[]>([]);
	const searching = Boolean(search.trim());
	const model = models.find((candidate) => candidate.id === modelId);
	function chooseModel(id: string) {
		onModelIdChange(id);
		setOpen(false);
	}
	const visibleModels = recentModelGenerations(models).filter(
		(candidate) =>
			candidate.label.toLowerCase().includes(search.trim().toLowerCase()) &&
			(!favoritesOnly ||
				favorites.includes(favoriteModelKey(harnessId, candidate.id))),
	);
	if (!selected) return null;

	function toggleFavorite(id: string) {
		const key = favoriteModelKey(harnessId, id);
		const next = favorites.includes(key)
			? favorites.filter((value) => value !== key)
			: [...favorites, key];
		setFavorites(next);
		writeModelFavorites(next);
	}

	return (
		<Popover
			open={open}
			onOpenChange={(value) => {
				setOpen(value);
				if (value) {
					setFavorites(readModelFavorites());
					setSearch("");
				}
			}}
		>
			<PopoverTrigger
				id={MODEL_PICKER_ID}
				className="composer-select harness-select"
				aria-label="Model"
				onPointerEnter={prefetchPlanUsage}
				onFocus={prefetchPlanUsage}
				title={`${selected.name}${model ? ` · ${model.label}` : ""}${speed === "ultrafast" ? " · Ultrafast" : speed ? " · Fast" : ""}`}
			>
				{harnessId === "api" ? (
					<ModelProviderLogo
						provider={
							parseModelRouteId(modelId)?.modelId.split("/")[0] ?? "openrouter"
						}
						size={16}
					/>
				) : (
					<AgentProviderMark provider={selected.id} size={16} />
				)}
				<span>{model?.label ?? "Select model"}</span>
				{speed ? (
					<Zap
						className="size-3 harness-select-speed"
						aria-label={speed === "ultrafast" ? "Ultrafast" : "Fast"}
					/>
				) : null}
				<ChevronDown className="size-3" />
			</PopoverTrigger>
			<PopoverContent
				collisionPadding={12}
				side="top"
				align="start"
				className="harness-picker"
				aria-label="Choose model"
			>
				<label className="model-picker-search">
					<Search size={16} aria-hidden="true" />
					<input
						aria-label="Search models"
						placeholder="Search models"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				</label>
				{model ? (
					<ModelPickerSettings
						model={model}
						reasoningId={reasoningId}
						onReasoningIdChange={onReasoningIdChange}
						speed={speed}
						onSpeedChange={onSpeedChange}
					/>
				) : null}
				<div className="model-picker-body">
					<nav className="model-provider-rail" aria-label="Model providers">
						<button
							type="button"
							aria-label={`Favorites in ${selected.name}`}
							title={`Favorites in ${selected.name}`}
							aria-pressed={favoritesOnly}
							onClick={() => {
								setBrowse(false);
								setFavoritesOnly(!favoritesOnly);
							}}
						>
							<Star size={19} />
						</button>
						{options
							.filter((option) => option.id === "codex")
							.map((option) => (
								<button
									key={option.id}
									className="model-provider-subscription"
									type="button"
									title={`${option.name} · ChatGPT subscription`}
									aria-label={option.name}
									aria-pressed={
										!browse && !favoritesOnly && harnessId === option.id
									}
									onClick={() => {
										setFavoritesOnly(false);
										setBrowse(false);
										setSearch("");
										if (option.id !== harnessId) onHarnessIdChange(option.id);
									}}
								>
									<AgentProviderMark provider={option.id} size={21} />
								</button>
							))}
						<ApiProviderRail
							selected={browse ? apiProvider : null}
							onSelect={(id) => {
								setBrowse(true);
								setApiProvider(id);
								setFavoritesOnly(false);
								setSearch("");
							}}
						/>
					</nav>
					<section
						className="model-picker-catalog"
						aria-label={
							searching
								? "Search all models"
								: browse
									? (AUTHOR_LABELS[apiProvider] ?? "OpenRouter")
									: selected.name
						}
					>
						{searching ? (
							<>
								<CodexModelSearch
									search={search}
									fallbackModels={harnessId === "codex" ? models : []}
									onSelect={(id) => {
										if (harnessId !== "codex") onHarnessIdChange("codex");
										onModelIdChange(id);
										setOpen(false);
									}}
								/>
								<ApiModelBrowser
									author={null}
									search={search}
									onBrowseProvider={(author) => {
										setApiProvider(author);
										setBrowse(true);
										setSearch("");
									}}
									selectedRoute={modelId}
									onSelect={(id) => {
										if (harnessId !== "api") onHarnessIdChange("api");
										onModelIdChange(id);
										setOpen(false);
									}}
								/>
							</>
						) : browse ? (
							<ApiModelBrowser
								key={apiProvider}
								author={apiProvider}
								search={search}
								selectedRoute={modelId}
								onSelect={(id) => {
									if (harnessId !== "api") {
										onHarnessIdChange("api");
										onModelIdChange(id);
										setOpen(false);
									} else chooseModel(id);
								}}
							/>
						) : (
							<>
								<h3>
									{favoritesOnly
										? `Favorites · ${selected.name}`
										: selected.name}
								</h3>
								{harnessId === "codex" ? (
									<p className="model-browser-caption">ChatGPT subscription</p>
								) : null}
								<div className="model-picker-list">
									{connectionContent}
									{visibleModels.map((candidate) => {
										const favorite = favorites.includes(
											favoriteModelKey(harnessId, candidate.id),
										);
										return (
											<div
												className="model-picker-row"
												key={candidate.id}
												data-selected={candidate.id === modelId}
											>
												<button
													type="button"
													className="model-picker-option"
													disabled={!modelsEnabled}
													aria-pressed={candidate.id === modelId}
													title={candidate.notice ?? candidate.label}
													onClick={() => {
														chooseModel(candidate.id);
													}}
												>
													<AgentProviderMark provider={harnessId} size={16} />
													<span>{candidate.label}</span>
													{candidate.id === modelId ? (
														<Check size={14} aria-hidden="true" />
													) : null}
												</button>
												<button
													type="button"
													className="model-favorite"
													aria-label={`${favorite ? "Unfavorite" : "Favorite"} ${candidate.label}`}
													aria-pressed={favorite}
													onClick={() => toggleFavorite(candidate.id)}
												>
													<Star
														size={16}
														fill={favorite ? "currentColor" : "none"}
													/>
												</button>
											</div>
										);
									})}
									{visibleModels.length === 0 && models.length > 0 ? (
										<p className="model-picker-status" role="status">
											{search.trim()
												? "No matching models"
												: "No favorites for this provider yet"}
										</p>
									) : null}
									{models.length === 0 ? (
										<div aria-busy={catalogStatus === "loading"}>
											<p className="model-picker-status" role="status">
												{catalogStatus === "loading"
													? "Fetching available models…"
													: catalogStatus === "error"
														? "Could not load saved models"
														: providerConnected
															? "No saved model list yet"
															: "Connect this provider once to discover its models"}
											</p>
											{onConnect && catalogStatus !== "loading" ? (
												<button
													type="button"
													className="model-picker-connect"
													onClick={() => {
														onConnect();
													}}
												>
													{catalogStatus === "error"
														? "Retry"
														: providerConnected
															? "Refresh models"
															: "Connect provider"}
												</button>
											) : null}
										</div>
									) : null}
								</div>
							</>
						)}
					</section>
				</div>
				<ModelPickerPlanUsage bars={planBars} />
				<ModelPickerUsage windows={usageWindows} />
			</PopoverContent>
		</Popover>
	);
}

function CodexModelSearch({
	search,
	fallbackModels,
	onSelect,
}: {
	search: string;
	fallbackModels: readonly SessionModel[];
	onSelect: (id: string) => void;
}) {
	const identity = authClient.useSession();
	const loadCatalog = useServerFn(getAgentModelCatalog);
	const catalog = useQuery({
		queryKey: ["agent-model-catalog", identity.data?.user.id, "codex"],
		enabled: Boolean(identity.data?.user.id),
		queryFn: () => loadCatalog({ data: { provider: "codex" } }),
		staleTime: 60_000,
	});
	const models = catalog.data
		? sessionModelsFromListed(catalog.data)
		: fallbackModels;
	const results = models.filter(
		(model) =>
			model.label.toLowerCase().includes(search.trim().toLowerCase()) ||
			"codex".includes(search.trim().toLowerCase()),
	);
	if (!results.length) return null;
	return (
		<>
			<h3>Codex · ChatGPT subscription</h3>
			{results.map((model) => (
				<button
					type="button"
					className="model-browser-option"
					key={model.id}
					onClick={() => onSelect(model.id)}
				>
					<AgentProviderMark provider="codex" size={16} />
					<span>{model.label}</span>
				</button>
			))}
		</>
	);
}
