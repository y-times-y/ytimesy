import { Check, Info, Plus, Star } from "lucide-react";
import {
	createContext,
	type KeyboardEvent,
	type PointerEvent,
	useContext,
} from "react";
import { type ReasoningLevel, reasoningLevelLabel } from "./model-capabilities";
import {
	INCLUDED_IN_PLAN,
	modelContextLabel,
	modelPriceDisplay,
	reasoningStepTarget,
} from "./model-picker-format";
import { ModelProviderLogo } from "./model-provider-logo";

/** What a row tells the detail card; all of it is already in the picker (no fetch). */
export type ModelDetailSpec = {
	/** The id the picker selects (a Codex slug or an API route id). */
	readonly id: string;
	readonly provider: "codex" | "api";
	readonly label: string;
	/** Provider key for the logo (see ModelProviderLogo). */
	readonly logo: string;
	/** The id the price and window tables know (a route id works). */
	readonly priceId: string;
	/** Billed by a plan (Codex, Claude Code, Grok): no price, "Included in plan". */
	readonly plan: boolean;
	/** A window the model's own listing states, when it has one. */
	readonly contextTokens?: number | null;
};

type ModelDetailControls = {
	/** Rows spread this: hovering with a mouse or focusing shows the card. */
	rowProps: (spec: ModelDetailSpec) => {
		onPointerEnter: (event: PointerEvent) => void;
		onFocus: () => void;
	};
	/** The touch way in: show the card for this row and expand it. */
	open: (spec: ModelDetailSpec) => void;
};

const ModelDetailContext = createContext<ModelDetailControls | null>(null);
export const ModelDetailProvider = ModelDetailContext.Provider;

/** Null outside the picker (a list rendered alone has no card). */
export function useModelDetail() {
	return useContext(ModelDetailContext);
}

/** The price at the end of a row, then a fixed slot for the check so nothing shifts. */
export function ModelRowMeta({
	priceId,
	plan,
	selected,
}: {
	priceId: string;
	plan: boolean;
	selected: boolean;
}) {
	const price = modelPriceDisplay(priceId, plan);
	return (
		<>
			{price ? (
				<span
					className="model-row-price"
					data-plan={price.kind === "plan" || undefined}
				>
					<span aria-hidden="true">
						{price.kind === "plan" ? INCLUDED_IN_PLAN : price.short}
					</span>
					<span className="sr-only">
						{price.kind === "plan"
							? `, ${INCLUDED_IN_PLAN}`
							: `, ${price.spoken}`}
					</span>
				</span>
			) : null}
			<span className="model-row-check" aria-hidden="true">
				{selected ? <Check size={14} /> : null}
			</span>
		</>
	);
}

/** The touch/mobile way into the card: hover does not exist there. */
export function ModelInfoButton({ spec }: { spec: ModelDetailSpec }) {
	const detail = useModelDetail();
	if (!detail) return null;
	return (
		<button
			type="button"
			className="model-row-info"
			aria-label={`Details for ${spec.label}`}
			onClick={() => detail.open(spec)}
		>
			<Info size={15} aria-hidden="true" />
		</button>
	);
}

const SLIDER_KEYS = [
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
	"Home",
	"End",
];

/** A segmented slider with ticks over the composer's own reasoning levels. */
export function ReasoningSlider({
	levels,
	valueId,
	onChange,
}: {
	levels: readonly ReasoningLevel[];
	valueId: string;
	onChange: (id: string) => void;
}) {
	const index = Math.max(
		0,
		levels.findIndex((level) => level.id === valueId),
	);
	const current = levels[index];
	function onKeyDown(event: KeyboardEvent) {
		if (!SLIDER_KEYS.includes(event.key)) return;
		// Arrows belong to the slider while it has focus, not to the list.
		event.preventDefault();
		event.stopPropagation();
		const target = reasoningStepTarget(levels, valueId, event.key);
		if (target) onChange(target);
	}
	return (
		<div
			className="reasoning-slider"
			role="slider"
			tabIndex={0}
			aria-label="Reasoning effort"
			aria-valuemin={0}
			aria-valuemax={levels.length - 1}
			aria-valuenow={index}
			aria-valuetext={current ? reasoningLevelLabel(current.id) : undefined}
			style={{
				["--steps" as string]: levels.length,
				["--index" as string]: index,
			}}
			onKeyDown={onKeyDown}
		>
			<span className="reasoning-slider-fill" aria-hidden="true" />
			{levels.map((level, step) => (
				<button
					type="button"
					tabIndex={-1}
					key={level.id}
					className="reasoning-slider-step"
					data-active={step === index || undefined}
					aria-label={reasoningLevelLabel(level.id)}
					onClick={() => onChange(level.id)}
				>
					<span className="reasoning-slider-tick" aria-hidden="true" />
				</button>
			))}
			<span className="reasoning-slider-thumb" aria-hidden="true" />
		</div>
	);
}

/** The side card (desktop) or inline expandable block (mobile) for the hovered or focused model. */
export function ModelDetailCard({
	spec,
	expanded,
	onExpandedChange,
	favorite,
	onToggleFavorite,
	reasoning,
}: {
	spec: ModelDetailSpec;
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
	favorite: boolean;
	onToggleFavorite: () => void;
	/** Only for the model the composer has selected: the setting is the composer's. */
	reasoning?: {
		levels: readonly ReasoningLevel[];
		valueId: string;
		onChange: (id: string) => void;
	};
}) {
	const price = modelPriceDisplay(spec.priceId, spec.plan);
	const context = modelContextLabel(spec.priceId, spec.contextTokens);
	const level = reasoning?.levels.find((item) => item.id === reasoning.valueId);
	return (
		<aside
			className="model-detail"
			aria-label={`${spec.label} details`}
			data-expanded={expanded}
		>
			<button
				type="button"
				className="model-detail-head"
				aria-expanded={expanded}
				onClick={() => onExpandedChange(!expanded)}
			>
				<ModelProviderLogo provider={spec.logo} size={16} />
				<span className="model-detail-name">{spec.label}</span>
				<span className="model-detail-summary">
					{price?.kind === "price"
						? price.short
						: price?.kind === "plan"
							? INCLUDED_IN_PLAN
							: ""}
				</span>
			</button>
			<div className="model-detail-body">
				<dl className="model-detail-facts">
					{context ? (
						<div>
							<dt>Context</dt>
							<dd>{context}</dd>
						</div>
					) : null}
					{price?.kind === "price" ? (
						<>
							<div>
								<dt>Input per 1M</dt>
								<dd>{price.input}</dd>
							</div>
							<div>
								<dt>Output per 1M</dt>
								<dd>{price.output}</dd>
							</div>
						</>
					) : null}
					{price?.kind === "plan" ? (
						<div>
							<dt>Price</dt>
							<dd>{INCLUDED_IN_PLAN}</dd>
						</div>
					) : null}
				</dl>
				{reasoning && reasoning.levels.length > 1 ? (
					<div className="model-detail-reasoning">
						<div className="model-detail-reasoning-head">
							<span>Reasoning</span>
							<span aria-hidden="true">
								{reasoningLevelLabel((level ?? reasoning.levels[0])?.id ?? "")}
							</span>
						</div>
						<ReasoningSlider {...reasoning} />
					</div>
				) : null}
				<button
					type="button"
					className="model-detail-favorite"
					aria-pressed={favorite}
					onClick={onToggleFavorite}
				>
					{favorite ? (
						<Star size={14} fill="currentColor" aria-hidden="true" />
					) : (
						<Plus size={14} aria-hidden="true" />
					)}
					{favorite ? "In favorites" : "Add to favorites"}
				</button>
			</div>
		</aside>
	);
}
