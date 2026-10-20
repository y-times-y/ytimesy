import {
	isModelRole,
	parseRoleModel,
	type RoleModels,
	roleModelsFlags,
	roleModelsFromUnknown,
} from "./role-models";

/**
 * Harness variants. DEFAULT_HARNESS_VARIANT is the product's behaviour for
 * everyone; in development, eval users (dev_eval_user) may pick other values
 * per run so concurrent evals can compare harness behaviour on one
 * deployment. Production only ever uses the default. See
 * docs/parallel-evals.md.
 */
export const HARNESS_VARIANT_VALUES = {
	/**
	 * How recalled memory (MEMORY.md and read-hook lines) is presented:
	 * rules = binding project rules from earlier chats (the default);
	 * notes = neutral data that may be outdated.
	 */
	memoryWording: ["notes", "rules"],
	/**
	 * Who writes cross-chat memory during a chat (dreaming always runs):
	 * observer = only the save hook (full mode) and dreaming, and the builder
	 * writes ~/memory only when the user explicitly asks it to remember
	 * something (the default); both = the builder saves proactively and the
	 * save hook runs after every turn; agent = only the builder, no save hook.
	 */
	memoryWriter: ["both", "agent", "observer"],
	/**
	 * The builder's tool surface (builderToolSurface in
	 * src/server/services/builder-shell-surface.ts): lean = our core four
	 * tools (read, write, edit, bash) for every model (the default,
	 * docs/decisions/2026-10-17-lean-tool-surface.md); current = the
	 * earlier measured shell surface; lean-native = each model family's own
	 * vendor harness tools.
	 */
	toolSurface: ["current", "lean-native", "lean"],
	/**
	 * Which requests share a provider prompt-cache routing key (the Codex
	 * subscription's session-id and prompt_cache_key, an API route's cache
	 * key): chat = one key per chat, like native Codex's per-thread key (the
	 * default); account = one key for all of the user's chats on that
	 * connection, so a new chat's first request can reuse the instructions and
	 * tools an earlier chat already cached.
	 */
	promptCacheScope: ["chat", "account"],
	/**
	 * Code mode on a lean surface: on adds run_code, a JavaScript program
	 * that calls the other tools (several reads, searches and commands in one
	 * model call; src/server/services/code-mode-tool.ts); primary makes
	 * run_code the main way to work (its description and instructions teach
	 * batching) and a large MCP setup's search and call tools callable only
	 * from inside run_code (searchTools(query) for their declarations);
	 * agent, agent_send and enter_plan_mode stay in the tool list. off
	 * offers the surface unchanged (the default).
	 */
	codeMode: ["off", "on", "primary"],
	/**
	 * Builder subagents (docs/subagents.md): on gives the builder the agent
	 * and agent_send tools (ordinary tools in the tool list, in every code
	 * mode), the orchestration prompt block, per-level
	 * budgets and the subagent tree; off offers the surface unchanged (the
	 * default) until the evals show it pays off.
	 */
	subagents: ["off", "on"],
	/**
	 * Pull request evidence: on makes the harness capture screenshots, a
	 * short recording or CLI output from the pushed commit when a turn's
	 * draft handoff has visible changes (or a `ytimesy-evidence` plan), store
	 * them and keep an Evidence section in the PR description current
	 * (src/server/services/pr-evidence.ts); off changes nothing (the default).
	 */
	prEvidence: ["off", "on"],
	/**
	 * The attempt loop (src/server/services/attempt-loop.ts, decision
	 * 2026-10-17 Phase 2): 3 = when the root builder finishes, an independent
	 * checker subagent tests the delivered result against the user's request;
	 * a failed or unsure attempt is kept as a candidate, the working tree is
	 * reset and the builder tries a different approach, up to three attempts
	 * within a time and token budget, and the best candidate is kept. 1 = one
	 * attempt, unchanged behaviour (the default).
	 */
	attempts: ["1", "3"],
	/**
	 * The review loop (src/server/services/review-loop.ts, decision
	 * 2026-10-18 "A"): on = when the root builder finishes a turn that
	 * changed files (and ran long enough or delivered something runnable),
	 * an independent checker subagent reviews the work against the user's
	 * request; concrete findings go back to the same run as one runtime
	 * notice and the builder verifies and fixes them, up to two rounds,
	 * within the time left. off = unchanged behaviour (the default). Not
	 * combined with attempts=3 (the attempt loop wins).
	 */
	review: ["off", "on"],
	/**
	 * Lead mode (src/domain/sidekick.ts, Devin Fusion style): fusion makes
	 * the root builder a lead that plans, briefs, reviews and answers the
	 * user, and makes its first writer a persistent sidekick (cheaper model
	 * via roleModels.writer) that keeps its context and fork across rounds of
	 * briefs and feedback, its fork synced with the lead's checkout before
	 * each round. Implies the agent tools (as subagents=on). off = unchanged
	 * behaviour (the default).
	 */
	lead: ["off", "fusion"],
} as const;

type Values = typeof HARNESS_VARIANT_VALUES;
export type HarnessVariant = {
	readonly [Key in keyof Values]: Values[Key][number];
} & {
	/**
	 * A model per subagent role (src/domain/role-models.ts): writer,
	 * researcher, reviewer, checker, judge. Empty (the default): every child
	 * runs on its parent's model. Flags: `roleModels.<role>=<model>[@<effort>]`.
	 */
	readonly roleModels: RoleModels;
};
export type MemoryWording = HarnessVariant["memoryWording"];
export type MemoryWriter = HarnessVariant["memoryWriter"];
export type HarnessToolSurfaceId = HarnessVariant["toolSurface"];
export type PromptCacheScope = HarnessVariant["promptCacheScope"];
export type CodeMode = HarnessVariant["codeMode"];
export type SubagentsMode = HarnessVariant["subagents"];
export type PrEvidence = HarnessVariant["prEvidence"];
export type AttemptsMode = HarnessVariant["attempts"];
export type ReviewMode = HarnessVariant["review"];
export type LeadMode = HarnessVariant["lead"];

export const DEFAULT_HARNESS_VARIANT: HarnessVariant = {
	memoryWording: "rules",
	memoryWriter: "observer",
	toolSurface: "lean",
	promptCacheScope: "chat",
	codeMode: "off",
	subagents: "off",
	prEvidence: "off",
	attempts: "1",
	review: "off",
	lead: "off",
	roleModels: {},
};

/**
 * The scope a turn's prompt-cache key is derived from (hashed with the user
 * and connection, never sent as is): the chat, or one fixed scope per
 * account.
 */
export function promptCacheScopeId(scope: PromptCacheScope, chatId: string) {
	return scope === "account" ? "account" : chatId;
}

function isKey(key: string): key is keyof Values {
	return Object.hasOwn(HARNESS_VARIANT_VALUES, key);
}

function validValue(key: keyof Values, value: unknown) {
	return (HARNESS_VARIANT_VALUES[key] as readonly unknown[]).includes(value);
}

/**
 * A stored variant: unknown keys and values fall back to the default, so a
 * row written by a newer script never breaks a turn.
 */
export function harnessVariantFromUnknown(value: unknown): HarnessVariant {
	const variant: Record<string, unknown> = { ...DEFAULT_HARNESS_VARIANT };
	if (value && typeof value === "object" && !Array.isArray(value))
		for (const [key, entry] of Object.entries(value))
			if (key === "roleModels")
				variant.roleModels = roleModelsFromUnknown(entry);
			else if (isKey(key) && validValue(key, entry)) variant[key] = entry;
	return variant as HarnessVariant;
}

/** `key=value` flags (e.g. `memoryWording=rules`); unknown keys or values throw. */
export function harnessVariantFromFlags(
	flags: readonly string[] = [],
): HarnessVariant {
	const variant: Record<string, unknown> = { ...DEFAULT_HARNESS_VARIANT };
	for (const flag of flags)
		for (const pair of flag.split(",")) {
			const [key, value, ...rest] = pair.split("=").map((part) => part.trim());
			const role = /^roleModels\.(.+)$/.exec(key ?? "")?.[1];
			if (role !== undefined && value !== undefined && !rest.length) {
				if (!isModelRole(role))
					throw new Error(
						`--variant roleModels.<role> takes a role in writer, researcher, reviewer, checker, judge; got "${role}".`,
					);
				variant.roleModels = {
					...(variant.roleModels as RoleModels),
					[role]: parseRoleModel(value),
				};
				continue;
			}
			if (!key || value === undefined || rest.length || !isKey(key))
				throw new Error(
					`--variant expects key=value with key in ${Object.keys(HARNESS_VARIANT_VALUES).join(", ")}; got "${pair}".`,
				);
			if (!validValue(key, value))
				throw new Error(
					`--variant ${key} accepts ${HARNESS_VARIANT_VALUES[key].join(", ")}; got "${value}".`,
				);
			variant[key] = value;
		}
	return variant as HarnessVariant;
}

/** Only the keys that differ from the default, for labels and stored rows. */
export function harnessVariantChanges(
	variant: HarnessVariant,
): Partial<HarnessVariant> {
	return Object.fromEntries(
		Object.entries(variant).filter(([key, value]) =>
			key === "roleModels"
				? Object.keys(value ?? {}).length > 0
				: DEFAULT_HARNESS_VARIANT[key as keyof HarnessVariant] !== value,
		),
	) as Partial<HarnessVariant>;
}

export function harnessVariantLabel(variant: HarnessVariant) {
	const changes = Object.entries(harnessVariantChanges(variant)).flatMap(
		([key, value]) =>
			key === "roleModels"
				? roleModelsFlags(value as RoleModels)
				: [`${key}=${value}`],
	);
	return changes.length ? changes.join(",") : "default";
}
