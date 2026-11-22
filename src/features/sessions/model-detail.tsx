import { Check, Info, Plus, Star } from "lucide-react";
import {
	createContext,
	type KeyboardEvent,
	type PointerEvent,
	useContext,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { isClaudeCodeRoute } from "#/domain/claude-code-route";
import { parseModelRouteId } from "#/domain/model-connection";
import {
	type ReasoningLevel,
	reasoningLevelLabel,
	type SessionModel,
} from "./model-capabilities";
import {
	INCLUDED_IN_PLAN,
	modelContextLabel,
	modelPriceDisplay,
	reasoningStepTarget,
} from "./model-picker-format";
import { ModelProviderLogo, modelLogoProvider } from "./model-provider-logo";

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

const CARD_GAP = 8;
const SCREEN_PAD = 8;
/** The side card's width (model-picker.css): the card measures itself against this, never its own width, which is the list's once it sits under it. */
export const DETAIL_CARD_WIDTH = 260;
/** Where CSS puts the card beside the list; narrower or touch screens keep it under the list. */
const SIDE_CARD_QUERY = "(min-width: 760px) and (hover: hover)";

/** Where the card goes so it stays on screen: right of the list, else left of it, else under it. */
export function cardSide(
	list: { left: number; right: number },
	cardWidth: number,
	viewportWidth: number,
): "right" | "left" | "inline" {
	if (list.right + CARD_GAP + cardWidth <= viewportWidth - SCREEN_PAD)
		return "right";
	return list.left - CARD_GAP - cardWidth >= SCREEN_PAD ? "left" : "inline";
}

/**
 * What the card shows before any row is hovered: the model the composer has
 * selected, built from the model itself, so the card (and the reasoning
 * slider it carries) is there as soon as the picker opens.
 */
export function selectedModelSpec(
	harnessId: "codex" | "api",
	modelId: string,
	model: Pick<SessionModel, "label" | "contextWindow"> | undefined,
): ModelDetailSpec | null {
	if (!model) return null;
	if (harnessId === "codex")
		return {
			id: modelId,
			provider: "codex",
			label: model.label,
			logo: "codex",
			priceId: modelId,
			plan: true,
			contextTokens: model.contextWindow?.standard,
		};
	const claude = isClaudeCodeRoute(modelId);
	return {
		id: modelId,
		provider: "api",
		label: model.label,
		logo: claude
			? "anthropic"
			: modelLogoProvider(parseModelRouteId(modelId)?.modelId ?? ""),
		priceId: modelId,
		plan: claude,
	};
}

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
	const ref = useRef<HTMLElement>(null);
	const [side, setSide] = useState<"right" | "left" | "inline">("right");
	// Beside the list on a wide screen; when the picker sits near an edge the
	// card flips to the other side, and sits under the list when neither fits.
	// Measured before paint and again whenever the window or the list changes
	// size, so a resize never leaves it off screen.
	useLayoutEffect(() => {
		const card = ref.current;
		const list = card?.parentElement;
		if (!card || !list) return;
		const place = () =>
			setSide(
				window.matchMedia(SIDE_CARD_QUERY).matches
					? cardSide(
							list.getBoundingClientRect(),
							DETAIL_CARD_WIDTH,
							window.innerWidth,
						)
					: "right",
			);
		place();
		// The popover moves a frame after a resize (and a list's own size does
		// not change), so measure again once it has settled.
		let frame = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settle = () => {
			place();
			cancelAnimationFrame(frame);
			clearTimeout(timer);
			frame = requestAnimationFrame(() => {
				frame = requestAnimationFrame(place);
			});
			timer = setTimeout(place, 150);
		};
		window.addEventListener("resize", settle);
		window.visualViewport?.addEventListener("resize", settle);
		const observer =
			typeof ResizeObserver === "undefined" ? null : new ResizeObserver(settle);
		observer?.observe(list);
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(timer);
			window.removeEventListener("resize", settle);
			window.visualViewport?.removeEventListener("resize", settle);
			observer?.disconnect();
		};
	}, []);
	const price = modelPriceDisplay(spec.priceId, spec.plan);
	const context = modelContextLabel(spec.priceId, spec.contextTokens);
	const level = reasoning?.levels.find((item) => item.id === reasoning.valueId);
	return (
		<aside
			ref={ref}
			className="model-detail"
			aria-label={`${spec.label} details`}
			data-expanded={expanded}
			data-side={side}
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
					{reasoning && reasoning.levels.length > 1
						? `${reasoningLevelLabel((level ?? reasoning.levels[0])?.id ?? "")} reasoning`
						: price?.kind === "price"
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
