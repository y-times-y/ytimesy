/**
 * The usage heatmap's colour and intensity rules, as pure functions so the
 * component only draws. Hues come from the Okabe-Ito set, which stays
 * distinguishable under the common colour-vision deficiencies; the five
 * intensity steps also differ in lightness (and the legend prints the token
 * thresholds), so colour is never the only signal.
 */
export const USAGE_PROVIDERS = [
	"anthropic",
	"openai",
	"xai",
	"google",
	"other",
] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];

export const USAGE_PROVIDER_LABELS: Record<UsageProvider, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI / Codex",
	xai: "xAI / Grok",
	google: "Google",
	other: "Others",
};

/** One hue per provider (Okabe-Ito: vermillion, bluish green, reddish purple, blue, grey). */
export const USAGE_PROVIDER_HUES: Record<UsageProvider, string> = {
	anthropic: "#d55e00",
	openai: "#009e73",
	xai: "#cc79a7",
	google: "#0072b2",
	other: "#8a8a8a",
};

/** Intensity levels 1 to 4; 0 is an empty day. */
export const USAGE_INTENSITY_LEVELS = 4;
/** Share of the strongest colour at each level; level 0 is the empty cell. */
export const USAGE_LEVEL_STRENGTH = [0, 28, 50, 75, 100] as const;

export type DayTokens = Partial<Record<UsageProvider, number>>;

export function dayTotal(day: DayTokens): number {
	return USAGE_PROVIDERS.reduce(
		(sum, provider) => sum + (day[provider] ?? 0),
		0,
	);
}

/** The provider with the most tokens that day; ties go to the earlier provider in the legend. */
export function dominantProvider(day: DayTokens): UsageProvider | null {
	let best: UsageProvider | null = null;
	let most = 0;
	for (const provider of USAGE_PROVIDERS) {
		const tokens = day[provider] ?? 0;
		if (tokens > most) {
			best = provider;
			most = tokens;
		}
	}
	return best;
}

/**
 * Upper bounds of levels 1 to 3 (level 4 is everything above), as shares of
 * the scale's maximum. The scale is the busiest day, so one outlier does not
 * flatten the rest: the cut points are square-root spaced.
 */
const LEVEL_CUTS = [0.0625, 0.25, 0.5625] as const;

/** Token thresholds for the legend: the first token count of each of levels 2 to 4. */
export function levelThresholds(scaleMax: number): readonly number[] {
	return LEVEL_CUTS.map((cut) => Math.max(1, Math.floor(scaleMax * cut) + 1));
}

export function intensityLevel(
	tokens: number,
	scaleMax: number,
): 0 | 1 | 2 | 3 | 4 {
	if (!(tokens > 0) || !(scaleMax > 0)) return 0;
	const share = tokens / scaleMax;
	if (share <= LEVEL_CUTS[0]) return 1;
	if (share <= LEVEL_CUTS[1]) return 2;
	if (share <= LEVEL_CUTS[2]) return 3;
	return 4;
}

export type HeatmapFilter = "all" | UsageProvider;

export type DayCell = {
	readonly tokens: number;
	readonly level: 0 | 1 | 2 | 3 | 4;
	/** The hue's provider; null for an empty day. */
	readonly provider: UsageProvider | null;
};

/**
 * One day's cell. "All" colours by the day's dominant provider and scales the
 * day's total against the busiest day; a provider filter shows only that
 * provider's tokens, scaled against its own busiest day.
 */
export function dayCell(
	day: DayTokens | undefined,
	filter: HeatmapFilter,
	scaleMax: number,
): DayCell {
	if (!day) return { tokens: 0, level: 0, provider: null };
	if (filter === "all") {
		const tokens = dayTotal(day);
		return {
			tokens,
			level: intensityLevel(tokens, scaleMax),
			provider: dominantProvider(day),
		};
	}
	const tokens = day[filter] ?? 0;
	return {
		tokens,
		level: intensityLevel(tokens, scaleMax),
		provider: tokens > 0 ? filter : null,
	};
}

/** The busiest day under the filter. */
export function scaleMaximum(
	days: Iterable<DayTokens>,
	filter: HeatmapFilter,
): number {
	let max = 0;
	for (const day of days)
		max = Math.max(max, filter === "all" ? dayTotal(day) : (day[filter] ?? 0));
	return max;
}

/**
 * The cell's fill as a CSS colour: the provider hue mixed into the theme's
 * empty-cell colour. Mixing in the page's own empty colour keeps one rule
 * for dark and light themes.
 */
export function cellFill(cell: DayCell): string {
	if (!cell.provider || cell.level === 0) return "var(--usage-cell-empty)";
	const strength = USAGE_LEVEL_STRENGTH[cell.level];
	return `color-mix(in srgb, var(--usage-hue-${cell.provider}) ${strength}%, var(--usage-cell-empty))`;
}

const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});
export const formatTokens = (tokens: number) =>
	tokens < 1000 ? String(Math.round(tokens)) : compact.format(tokens);
