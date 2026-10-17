import type { ToolSet } from "ai";
import type { HarnessToolSurfaceId } from "#/domain/harness-variant";

/**
 * Development harness variant `toolSurface` (docs/parallel-evals.md): what a
 * root or child turn offers the model, selected per eval user. Production and
 * every regular user always get "current".
 *
 * A surface receives the turn's own tools after the builder shell surface is
 * chosen and before MCP, plugin, web-search, plan and secret tools are added
 * (those keep working unchanged), and may rewrite the system prompt it ends
 * with. Both run once per durable step; keep them pure and deterministic so the
 * tools and prompt stay byte-stable for prompt caching.
 */
export type HarnessToolSurface = {
	tools(input: HarnessToolSurfaceInput): ToolSet;
	/** The finished system prompt (builder instructions plus memory). */
	instructions?(prompt: string, input: { tools: ToolSet }): string;
};

export type HarnessToolSurfaceInput = {
	readonly tools: ToolSet;
	/** The builder's shell surface (writable root or child), not read-only. */
	readonly shellBuilder: boolean;
	readonly writable: boolean;
	/** Codex subscription freeform apply_patch / OpenAI hosted apply_patch. */
	readonly freeformPatch: boolean;
	readonly nativePatch: boolean;
};

const SURFACES: Partial<Record<HarnessToolSurfaceId, HarnessToolSurface>> = {
	current: { tools: ({ tools }) => tools },
	// "lean-native" and "lean-pi" are reserved: add an entry here.
};

export function implementedToolSurfaces(): HarnessToolSurfaceId[] {
	return Object.keys(SURFACES) as HarnessToolSurfaceId[];
}

/** Refuses a reserved surface rather than silently measuring "current". */
export function harnessToolSurface(id: HarnessToolSurfaceId) {
	const surface = SURFACES[id];
	if (!surface)
		throw new Error(`Harness tool surface "${id}" is not implemented.`);
	return surface;
}

/** The system prompt as the surface rewrites it (unchanged by default). */
export function surfaceInstructions(
	surface: HarnessToolSurface,
	tools: ToolSet,
	prompt: string,
) {
	return surface.instructions
		? surface.instructions(prompt, { tools })
		: prompt;
}
