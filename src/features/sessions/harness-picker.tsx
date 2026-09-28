import { ChevronDown, Search, Star } from "lucide-react";
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
import { AUTHOR_LABELS } from "#/domain/browse-models";
import {
	enableMultipleModelAttempts,
	type ModelAttemptSlot,
	modelAttemptSummary,
	modelAttemptTotal,
	setModelAttemptCount,
	toggleModelAttempt,
} from "#/domain/model-attempts";
import { parseModelRouteId } from "#/domain/model-connection";
import { AgentProviderMark } from "./agent-provider-mark";
import { ApiModelBrowser } from "./api-model-browser";
import { ModelAttemptRows, MultipleModelsToggle } from "./model-attempt-menu";
import type { SessionModel } from "./model-capabilities";
import {
	favoriteModelKey,
	readModelFavorites,
	writeModelFavorites,
} from "./model-picker-favorites";
import { ModelPickerSettings } from "./model-picker-settings";
import { ModelProviderLogo } from "./model-provider-logo";
import { ProviderApiKeyInput } from "./provider-api-key-input";

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
	fast = false,
	onFastChange,
	multipleModels = false,
	attemptSlots = [],
	onMultipleModelsChange,
	onAttemptSlotsChange,
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
	fast?: boolean;
	onFastChange?: (value: boolean) => void;
	multipleModels?: boolean;
	attemptSlots?: readonly ModelAttemptSlot[];
	onMultipleModelsChange?: (enabled: boolean) => void;
	onAttemptSlotsChange?: (slots: ModelAttemptSlot[]) => void;
}) {
	const options = offeredAgentProviders();
	const selected =
		options.find((option) => option.id === harnessId) ?? options[0];
	const [open, setOpen] = useState(false);
	const [browse, setBrowse] = useState(
		harnessId === "api" || harnessId === "claude",
	);
	const [apiProvider, setApiProvider] = useState(
		harnessId === "claude" ? "anthropic" : "openai",
	);
	const [search, setSearch] = useState("");
	const [favoritesOnly, setFavoritesOnly] = useState(false);
	const [favorites, setFavorites] = useState<readonly string[]>([]);
	const multiple = Boolean(onMultipleModelsChange) && multipleModels;
	const slots = multiple ? attemptSlots : [];
	const attemptTotal = multiple ? modelAttemptTotal(slots) : 1;
	const primaryId = multiple ? (slots[0]?.modelId ?? "") : modelId;
	const model = models.find((candidate) => candidate.id === primaryId);
	const triggerLabel = modelAttemptSummary(
		model?.label ?? "",
		model ? attemptTotal : 0,
	);
	const extraRuns = model && attemptTotal > 1 ? attemptTotal - 1 : 0;
	const visibleModels = models.filter(
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

	function applyAttemptSlots(next: ModelAttemptSlot[]) {
		onAttemptSlotsChange?.(next);
		const primary = next[0]?.modelId ?? "";
		if (primary !== modelId) onModelIdChange(primary);
	}

	function chooseModel(id: string) {
		if (!multiple) {
			onModelIdChange(id);
			setOpen(false);
			return;
		}
		applyAttemptSlots(toggleModelAttempt(slots, id));
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
				id="session-harness-select"
				className="composer-select harness-select"
				aria-label="Model"
				title={triggerLabel}
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
				{extraRuns > 0 ? (
					<span className="harness-select-more">+ {extraRuns}</span>
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
				{onMultipleModelsChange ? (
					<MultipleModelsToggle
						checked={multiple}
						onCheckedChange={(checked) => {
							onMultipleModelsChange(checked);
							if (checked) {
								setBrowse(false);
								applyAttemptSlots(enableMultipleModelAttempts(modelId));
							}
						}}
					/>
				) : null}
				{model ? (
					<ModelPickerSettings
						model={model}
						reasoningId={reasoningId}
						onReasoningIdChange={onReasoningIdChange}
						fast={fast}
						onFastChange={onFastChange}
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
						{Object.entries(AUTHOR_LABELS).map(([id, label]) => (
							<button
								type="button"
								key={id}
								title={label}
								aria-label={label}
								aria-pressed={browse && apiProvider === id}
								onClick={() => {
									setBrowse(true);
									setApiProvider(id);
									setFavoritesOnly(false);
									setSearch("");
								}}
							>
								<ModelProviderLogo provider={id} size={21} />
							</button>
						))}
					</nav>
					<section
						className="model-picker-catalog"
						aria-label={
							browse
								? (AUTHOR_LABELS[apiProvider] ?? "OpenRouter")
								: selected.name
						}
					>
						{browse ? (
							<ApiModelBrowser
								key={apiProvider}
								author={apiProvider}
								search={search}
								onSelect={(id) => {
									if (harnessId !== "api") {
										onHarnessIdChange("api");
										onModelIdChange(id);
										setOpen(false);
										return;
									}
									chooseModel(id);
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
									{harnessId === "claude" ? (
										<ProviderApiKeyInput onSaved={onConnect} />
									) : (
										connectionContent
									)}
									<ModelAttemptRows
										models={visibleModels}
										harnessId={harnessId}
										modelId={modelId}
										modelsEnabled={modelsEnabled}
										multiple={multiple}
										slots={slots}
										favoriteIds={
											new Set(
												visibleModels
													.filter((candidate) =>
														favorites.includes(
															favoriteModelKey(harnessId, candidate.id),
														),
													)
													.map((candidate) => candidate.id),
											)
										}
										onChoose={chooseModel}
										onCountChange={(id, count) =>
											applyAttemptSlots(setModelAttemptCount(slots, id, count))
										}
										onToggleFavorite={toggleFavorite}
									/>
									{visibleModels.length === 0 && models.length > 0 ? (
										<p className="model-picker-status" role="status">
											{search.trim()
												? "No matching models"
												: "No favorites for this provider yet"}
										</p>
									) : null}
									{models.length === 0 && harnessId !== "claude" ? (
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
			</PopoverContent>
		</Popover>
	);
}
