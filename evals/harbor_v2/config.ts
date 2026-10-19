import {
	DEFAULT_HARNESS_VARIANT,
	type HarnessVariant,
	harnessVariantFromFlags,
} from "../../src/domain/harness-variant";
import {
	type ModelProvider,
	parseModelRouteId,
} from "../../src/domain/model-connection";
import {
	type ModelBilling,
	modelBilling,
} from "../../src/domain/model-pricing";

/**
 * How a Harbor bridge v2 trial is configured: environment variables the
 * Python agent passes through unchanged (docs/harbor-bridge-v2.md). Every
 * value is checked before any inference; anything unsupported fails the
 * trial instead of being silently ignored.
 */

export const HARBOR_ROUTES = [
	"openai-api",
	"anthropic",
	"gemini",
	"codex-subscription",
] as const;
export type HarborRoute = (typeof HARBOR_ROUTES)[number];

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type HarborEffort = (typeof EFFORTS)[number];

type ApiEndpoint = {
	provider: ModelProvider;
	baseUrl: string;
	defaultModel: string;
	defaultKeyFile: string;
	/** An environment variable that may hold the key instead of the file. */
	keyEnv: string;
};

export const API_ENDPOINTS: Record<
	Exclude<HarborRoute, "codex-subscription">,
	ApiEndpoint
> = {
	"openai-api": {
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-6.1-sol",
		defaultKeyFile: ".secrets/openai-api-key",
		keyEnv: "OPENAI_API_KEY",
	},
	anthropic: {
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com/v1",
		defaultModel: "claude-opus-5-5",
		defaultKeyFile: ".secrets/anthropic-api-key",
		keyEnv: "ANTHROPIC_API_KEY",
	},
	gemini: {
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		defaultModel: "gemini-3.8-flash",
		defaultKeyFile: ".secrets/gemini-api-key",
		keyEnv: "GEMINI_API_KEY",
	},
};

/**
 * Variant keys the bridge implements. The rest (memory, subagents, PR
 * evidence, the attempt loop) need the product's database and job stack;
 * a non-default value for them is refused. roleModels is implemented for
 * the one child the bridge runs, the review loop's checker.
 */
export const BRIDGE_VARIANT_KEYS = [
	"toolSurface",
	"codeMode",
	"review",
	"promptCacheScope",
	"roleModels",
] as const satisfies readonly (keyof HarnessVariant)[];

/** A model run in the trial: the builder's, or the checker's own (roleModels.checker). */
export type HarborModel = {
	modelId: string;
	effort: HarborEffort;
	billing: ModelBilling;
};

export type HarborBridgeConfig = {
	route: HarborRoute;
	modelId: string;
	effort: HarborEffort;
	variant: HarnessVariant;
	/** The model's list-price billing: a plan route's dollars are an estimate. */
	billing: ModelBilling;
	/**
	 * The review checker's model (roleModels.checker) on the builder's route;
	 * null: the checker runs on the builder's model, as the product's
	 * roleModels does for a role without an entry.
	 */
	checker: HarborModel | null;
	/** Per-trial dollar cap, checked before every model request; null only on a plan route without one set. */
	trialUsdCap: number | null;
	/** The shared spend ledger and its total cap (required on paid routes). */
	total: { ledger: string; capUsd: number } | null;
	/** Model requests per trial (builder and checker together). */
	requestLimit: number;
	/** The provider's hosted web search, as the product offers it. */
	webSearch: boolean;
	/** Where the key is read from (API routes). */
	keyFile: string | null;
	keyEnv: string | null;
};

type Env = Record<string, string | undefined>;

function positiveDollars(name: string, value: string | undefined) {
	if (value === undefined || value === "") return undefined;
	const amount = Number(value);
	if (!(Number.isFinite(amount) && amount > 0))
		throw new Error(`${name} must be a positive dollar amount.`);
	return amount;
}

export function harborBridgeConfig(env: Env): HarborBridgeConfig {
	const route = (env.YTIMESY_HARBOR_ROUTE ?? "") as HarborRoute;
	if (!HARBOR_ROUTES.includes(route))
		throw new Error(
			`YTIMESY_HARBOR_ROUTE must be one of ${HARBOR_ROUTES.join(", ")}.`,
		);
	// Each route keeps its own billing approval, as the builder evaluator does.
	if (env.YTIMESY_HARBOR_APPROVED !== route)
		throw new Error(
			`Set YTIMESY_HARBOR_APPROVED=${route} to approve this route's spending.`,
		);
	const endpoint = route === "codex-subscription" ? null : API_ENDPOINTS[route];
	const modelId =
		env.YTIMESY_HARBOR_MODEL || endpoint?.defaultModel || "gpt-6.1-sol";
	const effort = (env.YTIMESY_HARBOR_EFFORT || "max") as HarborEffort;
	if (!EFFORTS.includes(effort))
		throw new Error(
			`YTIMESY_HARBOR_EFFORT must be one of ${EFFORTS.join(", ")}.`,
		);
	const variant = harnessVariantFromFlags(
		env.YTIMESY_HARBOR_VARIANT ? [env.YTIMESY_HARBOR_VARIANT] : [],
	);
	const unsupported = (Object.keys(variant) as (keyof HarnessVariant)[]).filter(
		(key) =>
			!(BRIDGE_VARIANT_KEYS as readonly string[]).includes(key) &&
			variant[key] !== DEFAULT_HARNESS_VARIANT[key],
	);
	// Writers, researchers, reviewers and the judge need subagents or attempts.
	const otherRoles = Object.keys(variant.roleModels).filter(
		(role) => role !== "checker",
	);
	if (otherRoles.length)
		unsupported.push(
			...otherRoles.map((role) => `roleModels.${role}` as keyof HarnessVariant),
		);
	if (unsupported.length)
		throw new Error(
			`The Harbor bridge does not implement ${unsupported.join(", ")}; they need the product's database and job stack.`,
		);
	const billing = modelBilling({
		harness: route === "codex-subscription" ? "codex" : "api",
		modelId,
	});
	const paid = route !== "codex-subscription";
	// A cap needs a price: an unpriced model cannot be capped, so it cannot run.
	if (paid && !billing.price)
		throw new Error(
			`No list price is known for ${modelId}; add it to KNOWN_MODEL_PRICES before a capped run.`,
		);
	const checker = checkerModel(route, variant, effort);
	if (checker && paid && !checker.billing.price)
		throw new Error(
			`No list price is known for the checker's ${checker.modelId}; add it to KNOWN_MODEL_PRICES before a capped run.`,
		);
	const totalCap = positiveDollars(
		"YTIMESY_HARBOR_TOTAL_USD_CAP",
		env.YTIMESY_HARBOR_TOTAL_USD_CAP,
	);
	const ledger = env.YTIMESY_HARBOR_SPEND_LEDGER || undefined;
	if ((totalCap === undefined) !== (ledger === undefined))
		throw new Error(
			"Set YTIMESY_HARBOR_TOTAL_USD_CAP and YTIMESY_HARBOR_SPEND_LEDGER together.",
		);
	if (paid && totalCap === undefined)
		throw new Error(
			"A paid route needs a total cap: set YTIMESY_HARBOR_TOTAL_USD_CAP and YTIMESY_HARBOR_SPEND_LEDGER.",
		);
	const explicitTrialCap = positiveDollars(
		"YTIMESY_HARBOR_TRIAL_USD_CAP",
		env.YTIMESY_HARBOR_TRIAL_USD_CAP,
	);
	// Unset: $20 per trial (the builder evaluator's default), within the total.
	const trialUsdCap =
		explicitTrialCap ??
		(paid ? Math.min(20, totalCap ?? Number.POSITIVE_INFINITY) : null);
	if (trialUsdCap !== null && trialUsdCap > 100)
		throw new Error("YTIMESY_HARBOR_TRIAL_USD_CAP must be at most $100.");
	if (trialUsdCap !== null && !billing.price)
		throw new Error(`No list price is known for ${modelId} to cap.`);
	if (totalCap !== undefined && trialUsdCap !== null && trialUsdCap > totalCap)
		throw new Error("The trial cap cannot exceed the total cap.");
	const requestLimit = Number(env.YTIMESY_HARBOR_REQUEST_LIMIT || 400);
	if (!(Number.isInteger(requestLimit) && requestLimit > 0))
		throw new Error("YTIMESY_HARBOR_REQUEST_LIMIT must be a positive integer.");
	const webSearch = (env.YTIMESY_HARBOR_WEB_SEARCH || "on") !== "off";
	return {
		route,
		modelId,
		effort,
		variant,
		billing,
		checker,
		trialUsdCap,
		total:
			totalCap !== undefined && ledger ? { ledger, capUsd: totalCap } : null,
		requestLimit,
		webSearch,
		keyFile: endpoint
			? env.YTIMESY_HARBOR_KEY_FILE || endpoint.defaultKeyFile
			: null,
		keyEnv: endpoint?.keyEnv ?? null,
	};
}

/**
 * roleModels.checker on the bridge: a model on the builder's route (one
 * transport and one credential per trial). `codex:<slug>` needs the
 * subscription route; `api:<model>` an API route; a bare `<model>` is taken
 * on the builder's route. An exact connection route (`api/<id>/<model>`)
 * names the product's stored connection and is refused, as is a model on
 * another route: the bridge refuses what it cannot run rather than falling
 * back silently.
 */
export function checkerModel(
	route: HarborRoute,
	variant: HarnessVariant,
	/** The builder's effort, used when the entry names none. */
	builderEffort: HarborEffort,
): HarborModel | null {
	const entry = variant.roleModels.checker;
	if (!entry) return null;
	if (entry.model.startsWith("api/") || parseModelRouteId(entry.model))
		throw new Error(
			`roleModels.checker "${entry.model}" names a stored connection; use codex:<slug>, api:<model> or <model> on the trial's route.`,
		);
	const [prefix, ...rest] = entry.model.split(":");
	const scoped = prefix === "codex" || prefix === "api";
	const modelId = scoped ? rest.join(":") : entry.model;
	const subscription = route === "codex-subscription";
	if (!modelId || (prefix === "codex" && !subscription))
		throw new Error(
			`roleModels.checker "${entry.model}" needs YTIMESY_HARBOR_ROUTE=codex-subscription.`,
		);
	if (prefix === "api" && subscription)
		throw new Error(
			`roleModels.checker "${entry.model}" needs an API route; this trial runs on the Codex subscription.`,
		);
	const effort = (entry.effort ?? builderEffort) as HarborEffort;
	if (!EFFORTS.includes(effort))
		throw new Error(
			`roleModels.checker effort must be one of ${EFFORTS.join(", ")}.`,
		);
	return {
		modelId,
		effort,
		billing: modelBilling({
			harness: subscription ? "codex" : "api",
			modelId,
		}),
	};
}
