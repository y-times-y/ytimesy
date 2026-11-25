/**
 * Bindings a production Worker must never lose. Alchemy and wrangler both
 * replace a Worker's bindings with what the deploy declares, and a binding
 * Alchemy cannot express (the Workers VPC network `CODEX_EGRESS`, which Codex
 * subscription traffic needs) silently turns into a variable or disappears.
 * `liveWorkerBindingProblems` reads the live Workers (read-only) so a deploy
 * can refuse, or roll back, when one is gone.
 */

export type LiveBinding = {
	readonly name: string;
	readonly type: string;
	readonly network_id?: string;
};

export type RequiredBinding = {
	readonly name: string;
	readonly type: string;
	readonly network_id?: string;
};

export const REQUIRED_PRODUCTION_BINDINGS: Readonly<
	Record<string, readonly RequiredBinding[]>
> = {
	"ytimesy-edge-executor-production": [
		{ name: "CODEX_EGRESS", type: "vpc_network", network_id: "cf1:network" },
	],
	"ytimesy-web-production": [
		{ name: "CODEX_EGRESS", type: "vpc_network", network_id: "cf1:network" },
	],
};

/** What is wrong with a Worker's bindings, or an empty list. */
export function missingRequiredBindings(
	script: string,
	live: readonly LiveBinding[],
	required: readonly RequiredBinding[] = REQUIRED_PRODUCTION_BINDINGS[script] ??
		[],
): string[] {
	const problems: string[] = [];
	for (const need of required) {
		const found = live.find((binding) => binding.name === need.name);
		if (!found)
			problems.push(`${script} has no ${need.name} binding (${need.type}).`);
		else if (found.type !== need.type)
			problems.push(
				`${script} binds ${need.name} as ${found.type}, not ${need.type}.`,
			);
		else if (need.network_id && found.network_id !== need.network_id)
			problems.push(
				`${script} binds ${need.name} to ${found.network_id ?? "no network"}, not ${need.network_id}.`,
			);
	}
	return problems;
}

const API = "https://api.cloudflare.com/client/v4";

/** Reads every required binding on the live production Workers (GET only). */
export async function liveWorkerBindingProblems(
	token: string,
	fetcher: typeof fetch = fetch,
): Promise<string[]> {
	const get = async <T>(path: string): Promise<T> => {
		const response = await fetcher(`${API}${path}`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok)
			throw new Error(
				`Cloudflare ${path.split("/")[1]} answered ${response.status}.`,
			);
		return ((await response.json()) as { result: T }).result;
	};
	const accounts = await get<{ id: string }[]>("/accounts");
	if (accounts.length !== 1)
		return [
			`The token sees ${accounts.length} Cloudflare accounts; expected one.`,
		];
	const problems: string[] = [];
	for (const script of Object.keys(REQUIRED_PRODUCTION_BINDINGS)) {
		try {
			const settings = await get<{ bindings?: LiveBinding[] }>(
				`/accounts/${accounts[0].id}/workers/scripts/${script}/settings`,
			);
			problems.push(
				...missingRequiredBindings(script, settings.bindings ?? []),
			);
		} catch (error) {
			problems.push(
				`${script}: bindings could not be read (${error instanceof Error ? error.message : "error"}).`,
			);
		}
	}
	return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const token =
		process.env.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_DEPLOY_TOKEN;
	if (!token) throw new Error("Set CLOUDFLARE_API_TOKEN.");
	const problems = await liveWorkerBindingProblems(token);
	if (problems.length) {
		console.error(
			`Live Worker bindings are wrong:\n- ${problems.join("\n- ")}`,
		);
		process.exit(1);
	}
	console.log("Live production Workers keep their required bindings.");
}
