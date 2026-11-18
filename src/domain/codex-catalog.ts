import { z } from "zod";
import {
	type ListedContextWindow,
	listedContextWindow,
} from "./context-window-option";

/**
 * The ChatGPT Codex model catalog's row and the pure rules on it (which
 * models a plan offers, fast mode, the larger window). No credentials, no
 * database: the edge reads the catalog, and a turn runner box receives the
 * one selected row (docs/turn-runner-boxes.md, "Subscription routes").
 */
export const catalogSchema = z.object({
	models: z.array(
		z.object({
			slug: z.string(),
			display_name: z.string().optional(),
			visibility: z.string().optional(),
			// Only logged (codex.catalog): which models the account is offered at
			// the pinned client version, and any minimum version they carry.
			minimal_client_version: z.string().optional(),
			supported_reasoning_levels: z
				.array(z.object({ effort: z.string() }))
				.optional(),
			default_reasoning_level: z.string().optional(),
			priority: z.number().optional(),
			context_window: z.number().positive().optional(),
			// "Maximum context window allowed for config overrides" (Codex's
			// openai_models.rs): Codex's `model_context_window` may raise the
			// window up to it. Only local compaction limits change; nothing about
			// the window is sent with a request.
			max_context_window: z.number().positive().nullish(),
			auto_compact_token_limit: z.number().positive().nullish(),
			// Fast mode, as Codex reads it: a "priority" service tier, or the
			// older "fast" speed tier.
			service_tiers: z.array(z.object({ id: z.string() })).optional(),
			additional_speed_tiers: z.array(z.string()).optional(),
		}),
	),
});
export type CatalogRow = z.infer<typeof catalogSchema>["models"][number];
export const FAST_SERVICE_TIER = "priority";

export function supportsFast(row: CatalogRow) {
	return (
		row.service_tiers?.some((tier) => tier.id === FAST_SERVICE_TIER) === true ||
		row.additional_speed_tiers?.includes("fast") === true
	);
}

/**
 * The larger window a plan model allows, as Codex applies
 * `model_context_window`: offered only when `max_context_window` exceeds the
 * standard `context_window`.
 */
export function codexContextWindowOption(
	row: Pick<CatalogRow, "context_window" | "max_context_window">,
): ListedContextWindow | undefined {
	return listedContextWindow({
		standard: row.context_window,
		alternate:
			row.max_context_window &&
			row.context_window &&
			row.max_context_window > row.context_window
				? row.max_context_window
				: undefined,
		note: CODEX_LARGE_CONTEXT_NOTE,
	});
}
/** Longer prompts use more of the plan's limits (developers.openai.com/codex/pricing). */
const CODEX_LARGE_CONTEXT_NOTE = "Longer chats use your plan's limits faster";

/**
 * The window and compaction limit a turn runs with. The larger window drops
 * the catalog's auto-compact limit, which was set for the standard window;
 * the budget then derives from the larger window, as Codex derives 90% of
 * an overridden window.
 */
export function codexTurnContext(
	row: Pick<
		CatalogRow,
		"context_window" | "max_context_window" | "auto_compact_token_limit"
	>,
	alternateContext: boolean,
): { contextWindow?: number; autoCompactTokenLimit?: number } {
	const option = alternateContext ? codexContextWindowOption(row) : undefined;
	if (option) return { contextWindow: option.alternate };
	return {
		contextWindow: row.context_window,
		autoCompactTokenLimit: row.auto_compact_token_limit ?? undefined,
	};
}

export type Catalog = z.infer<typeof catalogSchema>;

/**
 * The model a turn runs on, chosen from the account's catalog with the same
 * checks wherever it runs (the edge for a box, the Durable Object itself).
 */
export function selectCodexModel(
	catalog: Catalog,
	input: {
		readonly modelId: string;
		readonly reasoning?: string;
		readonly fast: boolean;
		readonly alternateContext: boolean;
	},
): { selected: CatalogRow; effort: string } {
	const selected = catalog.models.find((row) => row.slug === input.modelId);
	// Plans change which models a ChatGPT account may use; the catalog is per account.
	if (!selected)
		throw new Error(
			"The selected model is no longer available on your current Codex plan. Choose another model.",
		);
	if (input.fast && !supportsFast(selected))
		throw new Error(
			"Fast mode is not available for this model on your ChatGPT plan.",
		);
	if (input.alternateContext && !codexContextWindowOption(selected))
		throw new Error(
			"A larger context window is not available for this model on your ChatGPT plan.",
		);
	const effort = input.reasoning ?? selected.default_reasoning_level ?? "low";
	if (
		selected.supported_reasoning_levels?.length &&
		!selected.supported_reasoning_levels.some(
			(level) => level.effort === effort,
		)
	)
		throw new Error("Selected reasoning level is unavailable for this model.");
	return { selected, effort };
}
