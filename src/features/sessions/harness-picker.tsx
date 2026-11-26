import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, RefreshCw, Search, Star, Zap } from "lucide-react";
import { contextWindowLabel } from "#/domain/context-window-option";
import "./model-picker.css";
import { type KeyboardEvent, type ReactNode, useState } from "react";
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
import {
	claudeCodeCoveredOpenRouterIds,
	claudeCodeSearchMatches,
	isClaudeCodeRoute,
} from "#/domain/claude-code-route";
import { parseModelRouteId } from "#/domain/model-connection";
import { apiPickerSections } from "#/domain/provider-access";
import {
	ModelPickerUsage,
	useCloudUsageWindows,
} from "../workspace/usage-windows";
import { AgentProviderMark } from "./agent-provider-mark";
import { ApiModelBrowser } from "./api-model-browser";
import { getClaudeSubscription } from "./claude-subscription.fn";
import { codexCatalogKey } from "./codex-catalog-store";
import {
	type ComposerSpeed,
	resolveReasoningLevel,
	type SessionModel,
	sessionModelsFromListed,
} from "./model-capabilities";
import { getModelConnections } from "./model-connections.fn";
import {
	ModelDetailCard,
	ModelDetailProvider,
	type ModelDetailSpec,
	ModelInfoButton,
	ModelRowMeta,
	selectedModelSpec,
	useModelDetail,
} from "./model-detail";
import {
	ModelFavoriteButton,
	type RenderModelFavorite,
} from "./model-favorite-button";
import {
	favoriteModelKey,
	readModelFavorites,
	writeModelFavorites,
} from "./model-picker-favorites";
import { nextFocusIndex } from "./model-picker-format";
import { ModelPickerSettings } from "./model-picker-settings";
import { ModelProviderLogo, modelLogoProvider } from "./model-provider-logo";
import {
	CLAUDE_PLAN_USAGE_HINT,
	SectionPlanUsage,
	useClaudePlanUsageLine,
	useGrokPlanUsageLine,
	usePlanUsageLine,
	usePrefetchPlanUsage,
} from "./plan-usage";
import { AccountPin } from "./subscription-accounts";
import { SubscriptionMark } from "./subscription-mark";
import { useCodexCatalog } from "./use-codex-catalog";

/** The composer's model button; Cmd+Shift+M clicks it. */
export const MODEL_PICKER_ID = "session-harness-select";

/** Shared with the composer's own read of the Codex catalog (session-launcher). */
export { codexCatalogKey };

/** Skeleton rows in the list's own row style while a catalog loads. */
function ModelListSkeleton() {
	return (
		<div className="model-picker-skeleton" aria-hidden="true">
			{[0, 1, 2].map((row) => (
				<div className="model-picker-row" key={row}>
					<span className="model-picker-option" />
				</div>
			))}
		</div>
	);
}

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
	alternateContext = false,
	onAlternateContextChange,
	withoutClaudeCode = false,
	agentSessionId,
}: {
	/** The saved chat, for choosing which of several plan accounts it uses. */
	agentSessionId?: string | null;
	/** Y²: no Claude subscription section (it has no machine for the CLI). */
	withoutClaudeCode?: boolean;
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
	alternateContext?: boolean;
	onAlternateContextChange?: (alternate: boolean) => void;
}) {
	const options = offeredAgentProviders();
	const selected =
		options.find((option) => option.id === harnessId) ?? options[0];
	const [open, setOpen] = useState(false);
	// Read with the composer, so the picker opens at its full height.
	const usageWindows = useCloudUsageWindows();
	const planUsage = usePlanUsageLine(open);
	const [browse, setBrowse] = useState(
		harnessId === "api" && !isClaudeCodeRoute(modelId),
	);
	const [claudeView, setClaudeView] = useState(
		harnessId === "api" && isClaudeCodeRoute(modelId),
	);
	const loadClaude = useServerFn(getClaudeSubscription);
	const claude = useQuery({
		queryKey: ["claude-subscription"],
		queryFn: () => loadClaude(),
		staleTime: 30_000,
	});
	const claudeData =
		!withoutClaudeCode && claude.data?.enabled ? claude.data : null;
	const claudeConnected =
		claudeData?.status === "connected" || claudeData?.status === "limited";
	const claudeUsage = useClaudePlanUsageLine(open, claudeConnected);
	const [apiProvider, setApiProvider] = useState("openai");
	// The Grok subscription's own rail entry: the xAI models, on the plan.
	const [grokView, setGrokView] = useState(false);
	const loadConnections = useServerFn(getModelConnections);
	const connections = useQuery({
		queryKey: ["model-connections"],
		queryFn: () => loadConnections(),
	});
	const grokSubscription = connections.data?.some(
		(connection) => connection.subscription?.provider === "xai",
	);
	const grokUsage = useGrokPlanUsageLine(open, Boolean(grokSubscription));
	const prefetchUsage = usePrefetchPlanUsage(
		claudeConnected,
		Boolean(grokSubscription),
	);
	const codexCatalog = useCodexCatalog();
	// Hover and focus warm only the plan usage: the Codex list comes from the
	// saved copy (or one read when there is none), never from the trigger.
	const prefetchPlanUsage = prefetchUsage;
	// The Codex section reads its own list; the active harness's `models` only
	// stand in for it when Codex is the active harness.
	// The account's own list wins (it is what "Refresh models" updates); the
	// active harness's models stand in while it has none.
	const accountModels = codexCatalog.models
		? sessionModelsFromListed(codexCatalog.models)
		: [];
	const codexModels = accountModels.length
		? accountModels
		: harnessId === "codex"
			? models
			: [];
	const codexStatus = accountModels.length
		? "ready"
		: harnessId === "codex"
			? catalogStatus
			: codexCatalog.status;
	const codexRetry = harnessId === "codex" ? onConnect : codexCatalog.refetch;
	const [search, setSearch] = useState("");
	const [favoritesOnly, setFavoritesOnly] = useState(false);
	const [favorites, setFavorites] = useState<readonly string[]>([]);
	// The model the side card shows: the last row hovered or focused. Set from
	// what the rows already hold, so hovering never reads anything.
	const [detail, setDetail] = useState<ModelDetailSpec | null>(null);
	const [detailExpanded, setDetailExpanded] = useState(false);
	const searching = Boolean(search.trim());
	const model = models.find((candidate) => candidate.id === modelId);
	function chooseModel(id: string) {
		onModelIdChange(id);
		setOpen(false);
	}
	const visibleModels = recentModelGenerations(codexModels).filter(
		(candidate) =>
			candidate.label.toLowerCase().includes(search.trim().toLowerCase()),
	);
	if (!selected) return null;

	function toggleFavorite(id: string, provider: AgentProviderId = harnessId) {
		const key = favoriteModelKey(provider, id);
		const next = favorites.includes(key)
			? favorites.filter((value) => value !== key)
			: [...favorites, key];
		setFavorites(next);
		writeModelFavorites(next);
	}

	function renderFavorite(provider: AgentProviderId): RenderModelFavorite {
		return (id, label) => (
			<ModelFavoriteButton
				label={label}
				favorite={favorites.includes(favoriteModelKey(provider, id))}
				onToggle={() => toggleFavorite(id, provider)}
			/>
		);
	}

	function detailRowProps(spec: ModelDetailSpec) {
		return {
			onPointerEnter: (event: { pointerType?: string }) => {
				if (event.pointerType === "mouse") setDetail(spec);
			},
			onFocus: () => setDetail(spec),
		};
	}
	// Arrow keys walk the options from the search box and between rows.
	function onPickerKeyDown(event: KeyboardEvent<HTMLElement>) {
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const target = event.target as HTMLElement;
		const inSearch = target.matches(".model-picker-search input");
		if (!inSearch && !target.matches("[data-model-option]")) return;
		if (inSearch && (event.key === "Home" || event.key === "End")) return;
		const options = Array.from(
			event.currentTarget.querySelectorAll<HTMLElement>(
				"[data-model-option]:not(:disabled)",
			),
		);
		const at = options.indexOf(target);
		if (inSearch && event.key === "ArrowUp") return;
		const next = inSearch ? 0 : nextFocusIndex(at, options.length, event.key);
		if (next === null) {
			if (!inSearch && event.key === "ArrowUp" && at === 0) {
				event.preventDefault();
				event.currentTarget
					.querySelector<HTMLInputElement>(".model-picker-search input")
					?.focus();
			}
			return;
		}
		event.preventDefault();
		options[next]?.focus();
		options[next]?.scrollIntoView({ block: "nearest" });
	}
	// The card shows the row last hovered or focused, and the selected model
	// until then, so the reasoning slider it carries is there at once.
	const shownDetail = detail ?? selectedModelSpec(harnessId, modelId, model);
	const detailSelected =
		shownDetail !== null &&
		shownDetail.provider === harnessId &&
		shownDetail.id === modelId;
	const detailModel = detailSelected ? model : undefined;
	const detailFavorite = shownDetail
		? favorites.includes(favoriteModelKey(shownDetail.provider, shownDetail.id))
		: false;

	return (
		<Popover
			open={open}
			onOpenChange={(value) => {
				setOpen(value);
				if (value) {
					setFavorites(readModelFavorites());
					setSearch("");
					setDetail(null);
					// On a phone the card sits under the list, always folded: open,
					// its slider took half the sheet and left one model row to
					// pick from. The folded row shows the reasoning level; a tap
					// opens it.
					setDetailExpanded(false);
					// Open on the section the chosen model belongs to: Codex,
					// Claude Code, the Grok plan, or its provider's API keys.
					const view = pickerViewFor(harnessId, modelId, connections.data);
					setFavoritesOnly(false);
					setClaudeView(view.kind === "claude");
					setGrokView(view.kind === "grok");
					setBrowse(view.kind === "grok" || view.kind === "api");
					if (view.kind === "grok") setApiProvider("x-ai");
					if (view.kind === "api") setApiProvider(view.author);
				}
			}}
		>
			<PopoverTrigger
				id={MODEL_PICKER_ID}
				className="composer-select harness-select"
				aria-label="Model"
				onPointerEnter={prefetchPlanUsage}
				onFocus={prefetchPlanUsage}
				title={`${selected.name}${model ? ` · ${model.label}` : ""}${speed === "ultrafast" ? " · Ultrafast" : speed ? " · Fast" : ""}${alternateContext && model?.contextWindow ? ` · ${contextWindowLabel(model.contextWindow.alternate)} context` : ""}`}
			>
				{harnessId === "api" ? (
					<ModelProviderLogo
						provider={
							isClaudeCodeRoute(modelId)
								? "anthropic"
								: modelLogoProvider(parseModelRouteId(modelId)?.modelId ?? "")
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
				onKeyDown={onPickerKeyDown}
			>
				<ModelDetailProvider
					value={{
						rowProps: detailRowProps,
						open: (spec) => {
							setDetail(spec);
							setDetailExpanded(true);
						},
					}}
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
							speed={speed}
							onSpeedChange={onSpeedChange}
							alternateContext={alternateContext}
							onAlternateContextChange={onAlternateContextChange}
						/>
					) : null}
					<div
						className="model-picker-body"
						// The mouse leaving the list brings back the selected model's
						// card, the one that carries the reasoning slider.
						onPointerLeave={(event) => {
							if (event.pointerType === "mouse") setDetail(null);
						}}
					>
						<nav className="model-provider-rail" aria-label="Model providers">
							<button
								type="button"
								aria-label="Favorites"
								title="Favorites across all models"
								aria-pressed={favoritesOnly}
								onClick={() => {
									setBrowse(false);
									setClaudeView(false);
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
										aria-pressed={!browse && !favoritesOnly && !claudeView}
										onClick={() => {
											setFavoritesOnly(false);
											setBrowse(false);
											setClaudeView(false);
											setGrokView(false);
											setSearch("");
										}}
									>
										<SubscriptionMark brand="codex" size={21} />
									</button>
								))}
							{claudeData ? (
								<button
									className="model-provider-subscription"
									type="button"
									title="Claude Agent · Claude subscription"
									aria-label="Claude Agent"
									aria-pressed={claudeView && !browse && !favoritesOnly}
									onClick={() => {
										setFavoritesOnly(false);
										setBrowse(false);
										setClaudeView(true);
										setGrokView(false);
										setSearch("");
									}}
								>
									<SubscriptionMark brand="claude" size={21} />
								</button>
							) : null}
							{grokSubscription ? (
								<button
									className="model-provider-subscription"
									type="button"
									title="Grok · Grok subscription"
									aria-label="Grok subscription"
									aria-pressed={
										browse &&
										grokView &&
										apiProvider === "x-ai" &&
										!favoritesOnly
									}
									onClick={() => {
										setFavoritesOnly(false);
										setClaudeView(false);
										setGrokView(true);
										setApiProvider("x-ai");
										setBrowse(true);
										setSearch("");
									}}
								>
									<SubscriptionMark brand="grok" size={21} />
								</button>
							) : null}
							<ApiProviderRail
								selected={browse && !grokView ? apiProvider : null}
								onSelect={(id) => {
									setBrowse(true);
									setGrokView(false);
									setClaudeView(false);
									setApiProvider(id);
									setFavoritesOnly(false);
									setSearch("");
								}}
							/>
						</nav>
						<section
							className="model-picker-catalog"
							aria-label={
								favoritesOnly
									? "Favorite models"
									: searching
										? "Search all models"
										: browse
											? (AUTHOR_LABELS[apiProvider] ?? "OpenRouter")
											: claudeView && claudeData
												? "Claude Agent"
												: "Codex"
							}
						>
							{searching || favoritesOnly ? (
								<>
									{favoritesOnly && favorites.length === 0 ? (
										<p className="model-picker-status">
											No favorites yet. Star a model in any list to add it here.
										</p>
									) : null}
									{claudeData ? (
										<ClaudeCodeSearch
											favoriteIds={favoritesOnly ? favorites : undefined}
											renderFavorite={renderFavorite("api")}
											models={claudeData.models}
											search={search}
											selectedRoute={harnessId === "api" ? modelId : ""}
											onSelect={(id) => {
												if (harnessId !== "api") onHarnessIdChange("api");
												onModelIdChange(id);
												setOpen(false);
											}}
										/>
									) : null}
									<CodexModelSearch
										favoriteIds={favoritesOnly ? favorites : undefined}
										renderFavorite={renderFavorite("codex")}
										search={search}
										fallbackModels={codexModels}
										onSelect={(id) => {
											if (harnessId !== "codex") onHarnessIdChange("codex");
											onModelIdChange(id);
											setOpen(false);
										}}
									/>
									<ApiModelBrowser
										renderFavorite={renderFavorite("api")}
										author={null}
										favoriteIds={favoritesOnly ? favorites : undefined}
										search={search}
										// The subscription row above is the usable one; no locked copy.
										coveredIds={
											claudeData
												? claudeCodeCoveredOpenRouterIds(claudeData.models)
												: undefined
										}
										hasOtherResults={
											favoritesOnly ||
											claudeCodeSearchMatches(claudeData?.models ?? [], search)
												.length > 0
										}
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
							) : claudeView && claudeData ? (
								<ClaudeCodeModels
									renderFavorite={renderFavorite("api")}
									models={claudeData.models}
									usage={
										<>
											<SectionPlanUsage
												line={claudeUsage}
												label="Claude plan"
												hint={CLAUDE_PLAN_USAGE_HINT}
											/>
											<AccountPin
												provider="claude"
												sessionId={agentSessionId}
											/>
										</>
									}
									selectedRoute={harnessId === "api" ? modelId : ""}
									onSelect={(id) => {
										if (harnessId !== "api") onHarnessIdChange("api");
										onModelIdChange(id);
										setOpen(false);
									}}
								/>
							) : browse ? (
								<ApiModelBrowser
									renderFavorite={renderFavorite("api")}
									key={`${apiProvider}:${grokView ? "plan" : "keys"}`}
									author={apiProvider}
									// Grok's plan has its own rail entry; xAI lists API keys only.
									source={
										apiProvider === "x-ai" && grokSubscription
											? grokView
												? "plan"
												: "keys"
											: undefined
									}
									usage={
										<SectionPlanUsage line={grokUsage} label="Grok plan" />
									}
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
								<CodexSection
									models={codexModels}
									visibleModels={visibleModels}
									status={codexStatus}
									onRetry={codexRetry}
									onRefresh={codexCatalog.refresh}
									refreshing={codexCatalog.refreshing}
									refreshDisabled={codexCatalog.cooling}
									search={search}
									modelId={harnessId === "codex" ? modelId : ""}
									modelsEnabled={modelsEnabled}
									providerConnected={providerConnected}
									connectionContent={
										harnessId === "codex" ? connectionContent : null
									}
									usage={
										<>
											<SectionPlanUsage line={planUsage} label="ChatGPT plan" />
											<AccountPin provider="codex" sessionId={agentSessionId} />
										</>
									}
									renderFavorite={renderFavorite("codex")}
									onSelect={(id) => {
										if (harnessId !== "codex") onHarnessIdChange("codex");
										chooseModel(id);
									}}
								/>
							)}
						</section>
					</div>
					<ModelPickerUsage windows={usageWindows} />
					{shownDetail ? (
						<ModelDetailCard
							spec={shownDetail}
							expanded={detailExpanded}
							onExpandedChange={setDetailExpanded}
							favorite={detailFavorite}
							onToggleFavorite={() =>
								toggleFavorite(shownDetail.id, shownDetail.provider)
							}
							reasoning={
								detailModel?.reasoning && onReasoningIdChange
									? {
											levels: detailModel.reasoning.levels,
											valueId:
												resolveReasoningLevel(detailModel, reasoningId)?.id ??
												"",
											onChange: onReasoningIdChange,
										}
									: undefined
							}
						/>
					) : null}
				</ModelDetailProvider>
			</PopoverContent>
		</Popover>
	);
}

/**
 * The Codex (ChatGPT plan) section. It is handed the plan's own list, never
 * an API model list: a loading catalog shows skeleton rows, not other models.
 */
export function CodexSection({
	models,
	visibleModels,
	status,
	onRetry,
	onRefresh,
	refreshing = false,
	refreshDisabled = false,
	search,
	modelId,
	modelsEnabled,
	providerConnected,
	connectionContent,
	usage,
	renderFavorite,
	onSelect,
}: {
	models: readonly SessionModel[];
	visibleModels: readonly SessionModel[];
	status: "loading" | "error" | "ready";
	onRetry?: () => void;
	/** Reads the account's list again (once a minute at most; the caller limits it). */
	onRefresh?: () => void;
	refreshing?: boolean;
	refreshDisabled?: boolean;
	search: string;
	modelId: string;
	modelsEnabled: boolean;
	providerConnected: boolean;
	connectionContent?: ReactNode;
	usage?: ReactNode;
	renderFavorite?: RenderModelFavorite;
	onSelect: (id: string) => void;
}) {
	const detail = useModelDetail();
	return (
		<>
			<div className="model-section-head">
				<h3>Codex</h3>
				{usage}
				{onRefresh ? (
					<button
						type="button"
						className="model-section-refresh"
						aria-label="Refresh model list"
						title="Check your ChatGPT plan for new models"
						disabled={refreshDisabled || refreshing}
						data-refreshing={refreshing}
						onClick={onRefresh}
					>
						<RefreshCw size={12} aria-hidden="true" />
					</button>
				) : null}
			</div>
			<p className="model-browser-caption">ChatGPT subscription</p>
			<div className="model-picker-list">
				{connectionContent}
				{models.length === 0 && status === "loading" ? (
					<ModelListSkeleton />
				) : null}
				{visibleModels.map((candidate) => {
					const spec = {
						id: candidate.id,
						provider: "codex",
						label: candidate.label,
						logo: "codex",
						priceId: candidate.id,
						plan: true,
						contextTokens: candidate.contextWindow?.standard,
					} as const;
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
								data-model-option
								aria-pressed={candidate.id === modelId}
								title={candidate.notice ?? candidate.label}
								{...detail?.rowProps(spec)}
								onClick={() => {
									onSelect(candidate.id);
								}}
							>
								<AgentProviderMark provider="codex" size={16} />
								<span>{candidate.label}</span>
								<ModelRowMeta
									priceId={candidate.id}
									plan
									selected={candidate.id === modelId}
								/>
							</button>
							{renderFavorite?.(candidate.id, candidate.label)}
							<ModelInfoButton spec={spec} />
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
					<div aria-busy={status === "loading"}>
						<p className="model-picker-status" role="status">
							{status === "loading"
								? "Fetching available models…"
								: status === "error"
									? "Could not load saved models"
									: providerConnected
										? "No saved model list yet"
										: "Connect this provider once to discover its models"}
						</p>
						{onRetry && status !== "loading" ? (
							<button
								type="button"
								className="model-picker-connect"
								onClick={() => {
									onRetry();
								}}
							>
								{status === "error"
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
	);
}

/** Claude Code's models (the user's Claude subscription), apart from API keys. */
export function ClaudeCodeModels({
	renderFavorite,
	models,
	usage,
	selectedRoute,
	onSelect,
}: {
	models: readonly { readonly id: string; readonly label: string }[];
	renderFavorite?: RenderModelFavorite;
	/** The Claude plan's usage line, under the caption. */
	usage?: ReactNode;
	selectedRoute: string;
	onSelect: (id: string) => void;
}) {
	const detail = useModelDetail();
	return (
		<>
			<div className="model-section-head">
				<h3>Claude Agent</h3>
				{usage}
			</div>
			<p
				className="model-browser-caption"
				title="Runs the Claude Agent SDK on the chat's machine, billed to your Claude plan."
			>
				Claude subscription
			</p>
			<div className="model-picker-list">
				{models.map((model) => {
					const spec = {
						id: model.id,
						provider: "api",
						label: model.label,
						logo: "anthropic",
						priceId: model.id,
						plan: true,
					} as const;
					return (
						<div
							className="model-picker-row"
							key={model.id}
							data-selected={model.id === selectedRoute}
						>
							<button
								type="button"
								className="model-picker-option"
								data-model-option
								aria-pressed={model.id === selectedRoute}
								title={`${model.label} in Claude Agent`}
								{...detail?.rowProps(spec)}
								onClick={() => onSelect(model.id)}
							>
								<ModelProviderLogo provider="anthropic" size={16} />
								<span>{model.label}</span>
								<ModelRowMeta
									priceId={model.id}
									plan
									selected={model.id === selectedRoute}
								/>
							</button>
							{renderFavorite?.(model.id, model.label)}
							<ModelInfoButton spec={spec} />
						</div>
					);
				})}
				{models.length === 0 ? (
					<p className="model-picker-status" role="status">
						Connect your Claude plan in Settings › Agents
					</p>
				) : null}
			</div>
		</>
	);
}

/** Search results from the connected Claude subscription, ranked above API-key models. */
function ClaudeCodeSearch({
	favoriteIds,
	renderFavorite,
	models,
	search,
	selectedRoute,
	onSelect,
}: {
	models: readonly { readonly id: string; readonly label: string }[];
	renderFavorite?: RenderModelFavorite;
	search: string;
	favoriteIds?: readonly string[];
	selectedRoute: string;
	onSelect: (id: string) => void;
}) {
	const results = (
		favoriteIds && !search.trim()
			? models
			: claudeCodeSearchMatches(models, search)
	).filter(
		(model) =>
			!favoriteIds || favoriteIds.includes(favoriteModelKey("api", model.id)),
	);
	const detail = useModelDetail();
	if (!results.length) return null;
	return (
		<>
			<h3>Claude Agent · Claude subscription</h3>
			{results.map((model) => {
				const spec = {
					id: model.id,
					provider: "api",
					label: model.label,
					logo: "anthropic",
					priceId: model.id,
					plan: true,
				} as const;
				return (
					<div className="model-picker-row" key={model.id}>
						<button
							type="button"
							className="model-browser-option model-browser-choice"
							data-model-option
							aria-pressed={model.id === selectedRoute}
							title={`${model.label} in Claude Agent`}
							{...detail?.rowProps(spec)}
							onClick={() => onSelect(model.id)}
						>
							<ModelProviderLogo provider="anthropic" size={16} />
							<span>{model.label}</span>
							<ModelRowMeta
								priceId={model.id}
								plan
								selected={model.id === selectedRoute}
							/>
						</button>
						{renderFavorite?.(model.id, model.label)}
						<ModelInfoButton spec={spec} />
					</div>
				);
			})}
		</>
	);
}

function CodexModelSearch({
	favoriteIds,
	renderFavorite,
	search,
	fallbackModels,
	onSelect,
}: {
	search: string;
	fallbackModels: readonly SessionModel[];
	favoriteIds?: readonly string[];
	renderFavorite?: RenderModelFavorite;
	onSelect: (id: string) => void;
}) {
	const detail = useModelDetail();
	const catalog = useCodexCatalog();
	const models = catalog.models
		? sessionModelsFromListed(catalog.models)
		: fallbackModels;
	const results = models
		.filter(
			(model) =>
				!favoriteIds ||
				favoriteIds.includes(favoriteModelKey("codex", model.id)),
		)
		.filter(
			(model) =>
				model.label.toLowerCase().includes(search.trim().toLowerCase()) ||
				"codex".includes(search.trim().toLowerCase()),
		);
	if (!results.length) return null;
	return (
		<>
			<h3>Codex · ChatGPT subscription</h3>
			{results.map((model) => {
				const spec = {
					id: model.id,
					provider: "codex",
					label: model.label,
					logo: "codex",
					priceId: model.id,
					plan: true,
					contextTokens: model.contextWindow?.standard,
				} as const;
				return (
					<div className="model-picker-row" key={model.id}>
						<button
							type="button"
							className="model-browser-option model-browser-choice"
							data-model-option
							{...detail?.rowProps(spec)}
							onClick={() => onSelect(model.id)}
						>
							<AgentProviderMark provider="codex" size={16} />
							<span>{model.label}</span>
							<ModelRowMeta priceId={model.id} plan selected={false} />
						</button>
						{renderFavorite?.(model.id, model.label)}
						<ModelInfoButton spec={spec} />
					</div>
				);
			})}
		</>
	);
}

/**
 * The picker section a chosen model lives in, so the picker never opens on a
 * list that mixes routes (an API model under no section looked like Codex's).
 */
export function pickerViewFor(
	harnessId: string,
	modelId: string,
	connections:
		| readonly {
				readonly id: string;
				readonly provider: string;
				readonly baseUrl?: string | null;
				readonly subscription?: { readonly provider: string } | null;
		  }[]
		| undefined,
):
	| { kind: "codex" }
	| { kind: "claude" }
	| { kind: "grok" }
	| { kind: "api"; author: string } {
	if (harnessId !== "api") return { kind: "codex" };
	if (isClaudeCodeRoute(modelId)) return { kind: "claude" };
	const route = parseModelRouteId(modelId);
	const connection = connections?.find(
		(candidate) => candidate.id === route?.connectionId,
	);
	if (connection?.subscription?.provider === "xai") return { kind: "grok" };
	const id = route?.modelId ?? "";
	if (id.includes("/")) return { kind: "api", author: id.split("/")[0] };
	if (connection?.provider === "compatible")
		return {
			kind: "api",
			author: connection.baseUrl?.includes("api.x.ai") ? "x-ai" : "custom",
		};
	return { kind: "api", author: connection?.provider ?? "openai" };
}
