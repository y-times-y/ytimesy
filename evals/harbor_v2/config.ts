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
import type { ModelRole } from "../../src/domain/role-models";
import {
	BEDROCK_DEFAULT_MODEL,
	BEDROCK_DEFAULT_REGION,
	BEDROCK_ENDPOINTS,
	BEDROCK_INFERENCE_PROFILES,
	BEDROCK_WEB_SEARCH_REGIONS,
	type BedrockEndpoint,
	type BedrockInferenceProfile,
	bedrockBaseUrl,
	bedrockModelId,
} from "./bedrock";

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
	"bedrock",
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
	Exclude<HarborRoute, "codex-subscription" | "bedrock">,
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

/** The product transport a route's requests use (bedrock: OpenAI Responses). */
export function routeProvider(
	route: HarborRoute,
): ModelProvider | "codex-subscription" {
	if (route === "codex-subscription") return route;
	if (route === "bedrock") return "openai";
	return API_ENDPOINTS[route].provider;
}

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
	"lead",
	"leadTools",
	"leadEffort",
	"checkerMode",
	"rigor",
	"grind",
	"effortMix",
	"envSnapshot",
	"goal",
] as const satisfies readonly (keyof HarnessVariant)[];

/**
 * The roles the bridge runs a child for: lead=fusion's one sidekick
 * (writer), the classifier judging its rounds, the model it escalates to
 * (writerEscalation), the review checker and checkerMode=pair's worker.
 * researcher, reviewer and judge need subagents=on or attempts=3.
 */
export const BRIDGE_ROLES = [
	"writer",
	"writerEscalation",
	"classifier",
	"checker",
	"checkerWorker",
] as const satisfies readonly ModelRole[];
export type BridgeRole = (typeof BRIDGE_ROLES)[number];

export const MULTI_WRITER_REFUSAL =
	"several writers at once (subagents=on/force) are product-only: they need the product's database and a VM fork per writer. The bridge runs one writer: lead=fusion with a single sidekick in the lead's own checkout.";

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
	/**
	 * Each bridge role's own model (roleModels.<role>) on the trial's route;
	 * a role without one runs on the builder's model.
	 */
	roles: Partial<Record<BridgeRole, HarborModel>>;
	/** Per-trial dollar cap, checked before every model request; null only on a plan route without one set. */
	trialUsdCap: number | null;
	/** The shared spend ledger and its total cap (required on paid routes). */
	total: { ledger: string; capUsd: number } | null;
	/** Model requests per trial (builder and checker together). */
	requestLimit: number;
	/** The provider's hosted web search, as the product offers it (bedrock: Bedrock Web Search on mantle). */
	webSearch: boolean;
	/** Where the key is read from (API routes). */
	keyFile: string | null;
	keyEnv: string | null;
	/** The bedrock route's Region, endpoint and inference profile; null elsewhere. */
	bedrock: {
		region: string;
		endpoint: BedrockEndpoint;
		baseUrl: string;
		profile: BedrockInferenceProfile;
	} | null;
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
	const endpoint =
		route === "codex-subscription" || route === "bedrock"
			? null
			: API_ENDPOINTS[route];
	const bedrock = route === "bedrock" ? bedrockSettings(env) : null;
	const requestedModel =
		env.YTIMESY_HARBOR_MODEL ||
		endpoint?.defaultModel ||
		(bedrock ? BEDROCK_DEFAULT_MODEL : "gpt-6.1-sol");
	// Mantle serves the foundation id; bedrock-runtime an inference profile.
	const modelId = bedrock
		? bedrockModelId(requestedModel, bedrock)
		: requestedModel;
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
	if (variant.subagents !== "off")
		throw new Error(
			`The Harbor bridge refuses subagents=${variant.subagents}: ${MULTI_WRITER_REFUSAL}`,
		);
	if (variant.checkerMode === "pair" && variant.review !== "on")
		throw new Error(
			"checkerMode=pair shapes the review loop's checker; set review=on with it.",
		);
	// Researchers, reviewers and the attempt loop's judge need subagents or attempts.
	const otherRoles = Object.keys(variant.roleModels).filter(
		(role) => !(BRIDGE_ROLES as readonly string[]).includes(role),
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
	const roles: Partial<Record<BridgeRole, HarborModel>> = {};
	for (const role of BRIDGE_ROLES) {
		const model = roleModelOnRoute(
			route,
			variant,
			role,
			effort,
			bedrock ?? undefined,
		);
		if (!model) continue;
		if (paid && !model.billing.price)
			throw new Error(
				`No list price is known for roleModels.${role}'s ${model.modelId}; add it to KNOWN_MODEL_PRICES before a capped run.`,
			);
		roles[role] = model;
	}
	const checker = roles.checker ?? null;
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
	// bedrock-runtime has no server-side tools: no hosted web search there.
	const runtimeEndpoint = bedrock?.endpoint === "runtime";
	const webSearch =
		(env.YTIMESY_HARBOR_WEB_SEARCH || (runtimeEndpoint ? "off" : "on")) !==
		"off";
	if (runtimeEndpoint && webSearch)
		throw new Error(
			"bedrock-runtime has no hosted web search (no server-side tools); use YTIMESY_HARBOR_BEDROCK_ENDPOINT=mantle, or set YTIMESY_HARBOR_WEB_SEARCH=off.",
		);
	if (
		bedrock &&
		webSearch &&
		!BEDROCK_WEB_SEARCH_REGIONS.includes(bedrock.region)
	)
		throw new Error(
			`Bedrock Web Search runs only in ${BEDROCK_WEB_SEARCH_REGIONS.join(", ")}; set YTIMESY_HARBOR_BEDROCK_REGION to one of them, or YTIMESY_HARBOR_WEB_SEARCH=off.`,
		);
	return {
		route,
		modelId,
		effort,
		variant,
		billing,
		checker,
		roles,
		trialUsdCap,
		total:
			totalCap !== undefined && ledger ? { ledger, capUsd: totalCap } : null,
		requestLimit,
		webSearch,
		keyFile: endpoint
			? env.YTIMESY_HARBOR_KEY_FILE || endpoint.defaultKeyFile
			: null,
		keyEnv: endpoint?.keyEnv ?? null,
		bedrock,
	};
}

function bedrockSettings(env: Env) {
	const region = env.YTIMESY_HARBOR_BEDROCK_REGION || BEDROCK_DEFAULT_REGION;
	const profile = (env.YTIMESY_HARBOR_BEDROCK_PROFILE ||
		"global") as BedrockInferenceProfile;
	if (!BEDROCK_INFERENCE_PROFILES.includes(profile))
		throw new Error(
			`YTIMESY_HARBOR_BEDROCK_PROFILE must be one of ${BEDROCK_INFERENCE_PROFILES.join(", ")}.`,
		);
	const endpoint = (env.YTIMESY_HARBOR_BEDROCK_ENDPOINT ||
		"mantle") as BedrockEndpoint;
	if (!BEDROCK_ENDPOINTS.includes(endpoint))
		throw new Error(
			`YTIMESY_HARBOR_BEDROCK_ENDPOINT must be one of ${BEDROCK_ENDPOINTS.join(", ")}.`,
		);
	return {
		region,
		endpoint,
		baseUrl: bedrockBaseUrl(region, endpoint),
		profile,
	};
}

type BedrockRouteIds = {
	endpoint: BedrockEndpoint;
	profile: BedrockInferenceProfile;
};

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
	bedrock?: BedrockRouteIds,
): HarborModel | null {
	return roleModelOnRoute(route, variant, "checker", builderEffort, bedrock);
}

/** roleModels.<role> on the trial's route, by checkerModel's rules. */
export function roleModelOnRoute(
	route: HarborRoute,
	variant: HarnessVariant,
	role: BridgeRole,
	builderEffort: HarborEffort,
	/** The bedrock route's endpoint and inference profile (default mantle). */
	bedrock: BedrockRouteIds = { endpoint: "mantle", profile: "global" },
): HarborModel | null {
	const entry = variant.roleModels[role];
	if (!entry) return null;
	if (entry.model.startsWith("api/") || parseModelRouteId(entry.model))
		throw new Error(
			`roleModels.${role} "${entry.model}" names a stored connection; use codex:<slug>, api:<model> or <model> on the trial's route.`,
		);
	const [prefix, ...rest] = entry.model.split(":");
	const scoped = prefix === "codex" || prefix === "api" || prefix === "bedrock";
	const named = scoped ? rest.join(":") : entry.model;
	const subscription = route === "codex-subscription";
	if (prefix === "bedrock" && route !== "bedrock")
		throw new Error(
			`roleModels.${role} "${entry.model}" needs YTIMESY_HARBOR_ROUTE=bedrock.`,
		);
	if (!named || (prefix === "codex" && !subscription))
		throw new Error(
			`roleModels.${role} "${entry.model}" needs YTIMESY_HARBOR_ROUTE=codex-subscription.`,
		);
	if (prefix === "api" && subscription)
		throw new Error(
			`roleModels.${role} "${entry.model}" needs an API route; this trial runs on the Codex subscription.`,
		);
	const modelId = route === "bedrock" ? bedrockModelId(named, bedrock) : named;
	const effort = (entry.effort ?? builderEffort) as HarborEffort;
	if (!EFFORTS.includes(effort))
		throw new Error(
			`roleModels.${role} effort must be one of ${EFFORTS.join(", ")}.`,
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
