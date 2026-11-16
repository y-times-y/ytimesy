import type { ToolSet } from "ai";
import type { LeanToolShape } from "#/domain/harness-model-profile";
import {
	type LeanEngine,
	type LeanEngineContext,
	leanEngine,
} from "./lean-engine";
import { claudeTools } from "./lean-shapes/claude";
import { codexTools } from "./lean-shapes/codex";
import { coreTools } from "./lean-shapes/core";
import { geminiTools } from "./lean-shapes/gemini";

/**
 * A lean shape's tools over an engine whose journal and helper installer the
 * caller chose: the edge's (lean-tools.ts) or the Claude runner box's
 * (claude-box-tools/), so both run the same tool code.
 */
export function leanShapeSurface(
	shape: LeanToolShape,
	base: ToolSet,
	context: LeanEngineContext,
): { tools: ToolSet; engine: LeanEngine } {
	const engine = leanEngine(base, context);
	const tools =
		shape === "codex"
			? codexTools(engine, base)
			: shape === "claude"
				? claudeTools(engine)
				: shape === "gemini" || shape === "qwen"
					? geminiTools(engine, shape === "qwen")
					: coreTools(engine);
	return { tools, engine };
}
