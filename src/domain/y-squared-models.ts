import { z } from "zod";
import type { AgentProviderId } from "./agent-provider";

/**
 * Which model a thread runs on is Y²'s call (docs/y.md, "Choosing a thread's
 * model"): `start_thread` takes an optional model, `set_thread_model` changes
 * an existing thread's, `list_models` shows what can be chosen. This file is
 * the pure part: the choice list, how a request is matched against it and
 * what the tools say. The server builds the list (y-squared-models.ts in
 * services) from the routes the person has connected.
 */

export const Y_SQUARED_LIST_MODELS_TOOL = "list_models";
export const Y_SQUARED_SET_THREAD_MODEL_TOOL = "set_thread_model";

export type ThreadModelTier = "frontier" | "balanced" | "fast";

/** One model a thread can run on, on one route. */
export type ThreadModel = {
	/** The route id the send path takes (what the composer's picker sends). */
	readonly id: string;
	readonly label: string;
	readonly harness: AgentProviderId;
	/** Where it runs: "Codex (ChatGPT plan)", "Claude plan", an API connection's name. */
	readonly route: string;
	readonly tier: ThreadModelTier | null;
	/** Reasoning levels this route accepts, weakest first; empty when none. */
	readonly reasoning: readonly string[];
	readonly defaultReasoning?: string;
	/** Faster speeds than standard ("fast", "ultrafast"); empty when none. */
	readonly speeds: readonly string[];
	/** False while the route's plan is used up or its sign-in needs renewing. */
	readonly usable: boolean;
	/** Why it is not usable now, in a few words. */
	readonly unavailable?: string;
	/** A plan window is at 90% or more: usable, but close to the limit. */
	readonly nearlySpent?: boolean;
};

/** What Y² may choose from right now. */
export type ThreadModelChoices = {
	/** The person's setting: false means Y² must not choose models. */
	readonly enabled: boolean;
	/** Automatic failover (a turn moves to another route when its plan runs out). */
	readonly failover: boolean;
	readonly models: readonly ThreadModel[];
};

export const Y_SQUARED_MODEL_CHOICE_OFF =
	'Choosing models is switched off for this project (Project settings > Y > "Let Y² choose a thread\'s model"). Threads use the default model. Tell the person once if they asked for a model, and that the switch is there.';

const TIER_NOTE: Record<ThreadModelTier, string> = {
	frontier: "strongest; slower and costlier",
	balanced: "strong all-rounder; moderate speed and cost",
	fast: "fastest and cheapest; lighter reasoning",
};

export function tierNote(tier: ThreadModelTier | null) {
	return tier ? TIER_NOTE[tier] : "not rated";
}

const key = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/** "claude-opus-5-5" out of "claude-code/claude-opus-5-5" or "api/<connection>/<model>". */
function bareModelId(id: string) {
	const rest = id.startsWith("api/")
		? id.split("/").slice(2).join("/")
		: id.replace(/^claude-code\//, "");
	try {
		return decodeURIComponent(rest);
	} catch {
		return rest;
	}
}

function labelWithoutRoute(label: string) {
	return label.split(" · ")[0] ?? label;
}

/** The request as the person or Y² might name it: route id, label, or the bare model name. */
function matches(model: ThreadModel, wanted: string) {
	return (
		key(model.id) === wanted ||
		key(model.label) === wanted ||
		key(labelWithoutRoute(model.label)) === wanted ||
		key(bareModelId(model.id)) === wanted
	);
}

export function modelChoiceLine(model: ThreadModel) {
	return [
		`- ${model.id} — ${model.label}`,
		`runs on ${model.route}`,
		tierNote(model.tier),
		model.usable
			? model.nearlySpent
				? "usable, but its plan is nearly used up"
				: "usable now"
			: `NOT usable now: ${model.unavailable ?? "unavailable"}`,
		model.reasoning.length
			? `reasoning: ${model.reasoning.join("/")}${model.defaultReasoning ? ` (default ${model.defaultReasoning})` : ""}`
			: "",
		model.speeds.length ? `speed: ${model.speeds.join("/")}` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

/** The `list_models` result: every model with its route, strength note and whether it can run now. */
export function modelListText(choices: ThreadModelChoices) {
	if (!choices.models.length)
		return "No model is connected for this person, so no thread can run. Tell them to connect one in Settings.";
	return [
		choices.enabled
			? "Pass a model's id (or its exact name) as `model` to start_thread or set_thread_model. Omit it for the default."
			: Y_SQUARED_MODEL_CHOICE_OFF,
		choices.failover
			? "Automatic failover is ON: a turn whose plan runs out continues on another route by itself."
			: "Automatic failover is OFF: a turn whose plan runs out stops, so never pick a route that is nearly used up.",
		...choices.models.map(modelChoiceLine),
	].join("\n");
}

function validChoices(models: readonly ThreadModel[]) {
	const usable = models.filter((model) => model.usable);
	const shown = usable
		.slice(0, 40)
		.map((model) => `${model.label} (id ${model.id})`)
		.join("; ");
	const down = models
		.filter((model) => !model.usable)
		.map((model) => `${model.label}: ${model.unavailable ?? "unavailable"}`)
		.join("; ");
	return `${
		shown
			? `Models you can choose now: ${shown}${usable.length > 40 ? `; and ${usable.length - 40} more (call list_models)` : ""}.`
			: "No model is usable right now."
	}${down ? ` Not usable now: ${down}.` : ""}`;
}

export type ThreadModelPick =
	| { readonly ok: true; readonly model: ThreadModel }
	| { readonly ok: false; readonly error: string };

/**
 * The model a request names, from what the person can run. Never falls back
 * to another model: an unknown or unavailable one is an error that lists the
 * valid choices. The same model on two routes picks the first usable one in
 * list order (plans come before keys); a route id names exactly one.
 */
export function resolveThreadModel(
	request: string,
	models: readonly ThreadModel[],
): ThreadModelPick {
	const wanted = key(request);
	const found = wanted ? models.filter((model) => matches(model, wanted)) : [];
	if (!found.length)
		return {
			ok: false,
			error: `Unknown model "${request}". ${validChoices(models)}`,
		};
	const usable = found.find((model) => model.usable);
	if (usable) return { ok: true, model: usable };
	const [first] = found as [ThreadModel];
	return {
		ok: false,
		error: `${first.label} is not usable now: ${first.unavailable ?? "unavailable"}. ${validChoices(models)}`,
	};
}

export type ThreadModelSettings = {
	readonly reasoning?: string;
	readonly speed?: string;
};

/** The reasoning level and speed a request asks for, checked against the model's own list. */
export function checkThreadModelSettings(
	model: ThreadModel,
	settings: ThreadModelSettings,
): string | null {
	if (settings.reasoning !== undefined) {
		const level = key(settings.reasoning);
		if (!model.reasoning.some((entry) => key(entry) === level))
			return `${model.label} on ${model.route} ${
				model.reasoning.length
					? `has reasoning ${model.reasoning.join(", ")}`
					: "has no reasoning setting"
			}; "${settings.reasoning}" is not one. Nothing was changed.`;
	}
	if (settings.speed !== undefined) {
		const speed = key(settings.speed);
		if (!model.speeds.some((entry) => key(entry) === speed))
			return `${model.label} on ${model.route} ${
				model.speeds.length
					? `has speeds ${model.speeds.join(", ")}`
					: "has no faster speed"
			}; "${settings.speed}" is not one. Nothing was changed.`;
	}
	return null;
}

/** The reasoning level spelled as the route lists it. */
export function canonicalReasoning(model: ThreadModel, requested: string) {
	return model.reasoning.find((entry) => key(entry) === key(requested));
}

export const THREAD_MODEL_LINE = (label: string) =>
	`Model changed to ${label} by the Super agent`;

const modelField = z
	.string()
	.trim()
	.min(1)
	.max(300)
	.describe(
		"A model's id or exact name from list_models (e.g. a route id, or a name like Claude Opus 5.5). Never guess: an unknown or unavailable model is refused with the valid choices.",
	);
const reasoningField = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.optional()
	.describe(
		"Reasoning effort, one of the levels list_models shows for that model. Omit for the model's default.",
	);
const speedField = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.optional()
	.describe(
		"A faster speed list_models shows for that model (fast, ultrafast). Omit for standard.",
	);

/** The model fields `start_thread` adds: all optional, so omitting them is today's default. */
export const startThreadModelFields = {
	model: modelField
		.optional()
		.describe(
			"Run this thread on this model instead of the default: a model's id or exact name from list_models. Only when the person names one or the selection policy gives a reason. Never guess: an unknown or unavailable model is refused with the valid choices.",
		),
	reasoning: reasoningField,
	speed: speedField,
};

export const setThreadModelInput = z.object({
	id: z.string().min(1).max(64).describe("The thread's id"),
	model: modelField,
	reasoning: reasoningField,
	speed: speedField,
	// Optional, not .default(): the schema every route shows the model keeps
	// the parameter plainly optional; execute applies false.
	interrupt: z
		.boolean()
		.optional()
		.describe(
			"A working thread: true stops its running turn first, then switches. Omit to change only an idle thread (a working one is refused: its running turn finishes on its current model).",
		),
});
export const listModelsInput = z.object({});

export const Y_SQUARED_LIST_MODELS_DESCRIPTION =
	"The models you can start a thread on, or switch one to: each with its id, the route it runs on (Codex plan, Claude plan, an API key, Grok, Gemini, OpenRouter…), a one-line strength/speed/cost note, whether it is usable right now (not a plan that is used up), its reasoning levels and speeds, and whether automatic failover is on. Call it before choosing a model, and when a thread hit a limit.";
export const Y_SQUARED_SET_THREAD_MODEL_DESCRIPTION =
	"Change the model of one of this project's threads. It keeps its conversation and checkpoint; the new model takes over from the thread's NEXT turn, and one quiet line (\"Model changed to X by the Super agent\") is added to the thread. An idle thread changes at once. A working thread is refused (its running turn finishes on its current model) unless interrupt is true: that stops the running turn first, then switches. Messages already waiting in the thread move to the new model too. Refused for threads that are not this person's and for yourself. An unknown or unavailable model is an error that lists the valid choices; it never falls back to a different one. Pass the thread's id from the threads list and a model from list_models.";

/** Y²'s selection policy, as the instruction lines. */
export function ySquaredModelPolicy(names: {
	readonly start: string;
	readonly set: string;
	readonly list: string;
}) {
	return [
		`- Choosing a thread's model: \`${names.start}\` takes an optional \`model\`, \`${names.set}\` changes an existing thread's, \`${names.list}\` shows what can be chosen (route, strength note, whether it can run now). Policy: (1) The person's own words win: if they name a model, use exactly that one, even where this policy would pick another. (2) Otherwise leave \`model\` out: the default is right most of the time. (3) Choose a stronger model only for risky or production-affecting work: infrastructure, deploys, migrations, security, hard debugging. (4) Choose a cheaper or faster one for research, summaries, small UI fixes and read-only investigations. (5) Never choose a route \`${names.list}\` shows as not usable, and avoid one whose plan is nearly used up. (6) Failover stays the safety net: do not switch a thread just because a limit might come; when a thread stopped on a limit and failover is off, switch it with \`${names.set}\`. (7) When the choice is not the default, say it in one short line ("Started A on Claude Opus 5.5: it touches production."). If a tool refuses a model, report that and the valid choices it listed; never retry with a different model unasked.`,
	].join("\n");
}
