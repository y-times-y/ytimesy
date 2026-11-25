import type { UsageProvider } from "./usage-heatmap";
import { dayString, type UsageSource } from "./usage-report";

export type SyntheticUsageRow = {
	readonly day: string;
	readonly provider: UsageProvider;
	readonly modelId: string;
	readonly project: 0 | 1 | null;
	readonly source: UsageSource;
	readonly turns: number;
	readonly unknownTurns: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
};

const MODELS: readonly { provider: UsageProvider; modelId: string }[] = [
	{ provider: "anthropic", modelId: "claude-sonnet-5-5" },
	{ provider: "anthropic", modelId: "claude-opus-5-5" },
	{ provider: "openai", modelId: "gpt-5.5" },
	{ provider: "xai", modelId: "grok-4.6" },
	{ provider: "google", modelId: "gemini-3-pro" },
	{ provider: "other", modelId: "deepseek-v4" },
];
const SOURCES: readonly UsageSource[] = ["box", "durable-object", "y2"];

/** A small deterministic generator (mulberry32), so a seed is reproducible. */
function random(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Made-up usage for the synthetic test account's heatmap: about 300 of the
 * last 365 days, quieter at weekends, a provider favoured per season, a few
 * heavy days, a few turns without counts. Nothing here is real data.
 */
export function syntheticUsage(today: string, days = 365): SyntheticUsageRow[] {
	const rand = random(20261125);
	const end = Math.floor(Date.parse(`${today}T00:00:00Z`) / 86_400_000);
	const rows: SyntheticUsageRow[] = [];
	for (let back = days - 1; back >= 0; back--) {
		const n = end - back;
		const weekday = new Date(n * 86_400_000).getUTCDay();
		if (rand() < (weekday === 0 || weekday === 6 ? 0.55 : 0.1)) continue;
		// The favourite rotates through the five named providers; "other" appears only by chance.
		const favourite = Math.floor(((days - back) / days) * 10) % 5;
		const picks = new Set([favourite, Math.floor(rand() * MODELS.length)]);
		const heavy = rand() < 0.06 ? 8 : 1;
		for (const pick of picks) {
			const model = MODELS[pick];
			if (!model) continue;
			const turns = 1 + Math.floor(rand() * 14 * heavy);
			const input = Math.floor(turns * (20_000 + rand() * 90_000));
			rows.push({
				day: dayString(n),
				provider: model.provider,
				modelId: model.modelId,
				project: rand() < 0.15 ? null : rand() < 0.5 ? 0 : 1,
				source: SOURCES[Math.floor(rand() * SOURCES.length)] ?? "box",
				turns,
				unknownTurns: rand() < 0.05 ? 1 : 0,
				inputTokens: input,
				outputTokens: Math.floor(input * (0.04 + rand() * 0.08)),
				cacheReadTokens: Math.floor(input * (0.3 + rand() * 0.5)),
			});
		}
	}
	return rows;
}
