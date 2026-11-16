import type { ToolSet } from "ai";
import type { LeanToolShape } from "#/domain/harness-model-profile";
import { journaledToolOperation } from "./journaled-tool-operation";
import type { LeanEngine, LeanSurfaceContext } from "./lean-engine";
import { ensureLeanHelpers } from "./lean-helpers";
import { leanShapeSurface } from "./lean-shape-surface";

/**
 * The lean builder surfaces (docs/builder-tool-surface.md): each model family
 * sees the tool names and argument shapes of its own vendor harness (or our own
 * core four), over one shared engine (lean-engine.ts). Commands go through
 * the runtime's execute/continue/stop tools (same runner, limits, journal and
 * background tracking); edits through one exact-then-fuzzy matcher; every
 * output through one limit (2000 lines / 50 KB, head for reads, tail for
 * commands, with the full command output kept in a file). Tool names come
 * from LEAN_SHAPE_TOOLS; each shape lives in lean-shapes/.
 */

export type { LeanCommandResult, LeanSurfaceContext } from "./lean-engine";

/**
 * The tools a lean shape offers, over the runtime's command tools in `base`.
 * Writes run once per tool call through the durable journal unless the
 * context gives its own `once`; helpers install with ensureLeanHelpers unless
 * it gives `installHelpers`.
 */
export function leanShapeTools(
	shape: LeanToolShape,
	base: ToolSet,
	context: LeanSurfaceContext,
): { tools: ToolSet; engine: LeanEngine } {
	return leanShapeSurface(shape, base, {
		...context,
		once:
			context.once ??
			((requestId, fingerprint, run) =>
				journaledToolOperation(
					{
						sessionId: context.sessionId,
						requestId,
						fingerprint,
						signal: context.signal,
					},
					run,
				)),
		installHelpers:
			context.installHelpers ??
			((workspace) => ensureLeanHelpers(workspace, context.sessionId)),
	});
}
