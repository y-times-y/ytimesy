/**
 * After a production deploy: does each Worker answer, and with the build just
 * deployed? deploy-production.ts runs these checks and rolls every Worker it
 * deployed back to its previous versions when one still fails. Only public
 * URLs, statuses and build ids are reported, never a response body.
 */

/** BUILD_ID_HEADER in src/lib/build-id.ts. */
const BUILD_ID_HEADER = "x-ytimesy-build";

export type SmokeResponse = {
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	readonly body: string;
};

export type SmokeCheck = {
	readonly name: string;
	readonly url: string;
	/** What is wrong with the answer, or null when it passes. */
	readonly problem: (response: SmokeResponse) => string | null;
};

/** One build id per production deploy: the commit, and when it was built. */
export function productionBuildId(commit: string, nowMs: number) {
	return `${commit.trim().slice(0, 12)}-${nowMs.toString(36)}`;
}

/**
 * The checks for one deploy. The web's run only once it has a public route
 * (YTIMESY_GO_LIVE); the edge's /health always does, on its custom domain.
 */
export function productionSmokeChecks(input: {
	readonly appUrl: string | null;
	readonly edgeUrl: string;
	readonly buildId: string;
}): SmokeCheck[] {
	const at = (base: string, path: string) => new URL(path, base).toString();
	const reportsBuild = (response: SmokeResponse) => {
		if (response.status !== 200) return `answered ${response.status}`;
		let build: unknown;
		try {
			build = (JSON.parse(response.body) as { build?: unknown }).build;
		} catch {
			return "answered without JSON";
		}
		return build === input.buildId
			? null
			: `serves build ${String(build).slice(0, 40)}, not ${input.buildId}`;
	};
	const checks: SmokeCheck[] = [];
	if (input.appUrl)
		checks.push(
			{
				name: "web home page",
				url: at(input.appUrl, "/"),
				problem: (response) => {
					if (response.status !== 200) return `answered ${response.status}`;
					if (!response.headers.get("content-type")?.includes("text/html"))
						return "answered without HTML";
					if (!/^\s*<!doctype html>/i.test(response.body))
						return "answered without an HTML document";
					if (!/<title>[^<]*ytimesy/i.test(response.body))
						return "answered without the ytimesy page title";
					const build = response.headers.get(BUILD_ID_HEADER);
					return build === input.buildId
						? null
						: `page is build ${build ?? "(none)"}, not ${input.buildId}`;
				},
			},
			{
				name: "web version",
				url: at(input.appUrl, "/api/version"),
				problem: reportsBuild,
			},
		);
	checks.push({
		name: "edge health",
		url: at(input.edgeUrl, "/health"),
		problem: reportsBuild,
	});
	return checks;
}

/**
 * Runs the checks until all pass, retrying the failing ones (a new version
 * takes a few seconds to reach every location). Returns what still fails
 * after the last attempt; empty means healthy.
 */
export async function runSmokeChecks(
	checks: readonly SmokeCheck[],
	request: (url: string) => Promise<SmokeResponse>,
	options: {
		readonly attempts: number;
		readonly delayMs: number;
		readonly sleep?: (ms: number) => Promise<unknown>;
		readonly log?: (line: string) => void;
	},
): Promise<string[]> {
	const sleep =
		options.sleep ??
		((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	let pending = [...checks];
	let problems: string[] = [];
	for (let attempt = 1; attempt <= options.attempts; attempt++) {
		problems = [];
		const failing: SmokeCheck[] = [];
		for (const check of pending) {
			let problem: string | null;
			try {
				problem = check.problem(await request(check.url));
			} catch (error) {
				problem = `unreachable (${error instanceof Error ? error.name : "error"})`;
			}
			if (problem) {
				failing.push(check);
				problems.push(`${check.name} (${check.url}): ${problem}`);
			} else options.log?.(`Smoke check passed: ${check.name}.`);
		}
		pending = failing;
		if (!pending.length) return [];
		if (attempt < options.attempts) {
			options.log?.(
				`Smoke check attempt ${attempt}/${options.attempts} failed; retrying:\n- ${problems.join("\n- ")}`,
			);
			await sleep(options.delayMs);
		}
	}
	return problems;
}
