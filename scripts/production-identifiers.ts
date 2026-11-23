/**
 * The owner's real Cloudflare and database identifiers, read from the live
 * account with the deploy token every chat receives (CLOUDFLARE_DEPLOY_TOKEN),
 * so a production deploy works from any chat. The public repository keeps
 * placeholders; the deploy used to need a hand-made private patch
 * (~/.ytimesy-private/production-overlay.patch) that only some machines had.
 *
 * Each value comes from what production runs now, not from the deploy's own
 * inputs: the account the token deploys to, the Hyperdrive configs the live
 * production and development Workers are bound to, and the database refs
 * those configs connect to. The deploy's database identity check
 * (DATABASE_URL must be production) then compares the env file against the
 * database production actually uses.
 */

export const PLACEHOLDER_ACCOUNT_ID = "00000000000000000000000000000000";
export const PLACEHOLDER_HYPERDRIVE_ID = "00000000000000000000000000000001";
export const PLACEHOLDER_PRODUCTION_REF = "exampleprojectref";
export const PLACEHOLDER_DEVELOPMENT_REF = "exampledevprojectref";

export type ProductionIdentifiers = {
	readonly accountId: string;
	readonly hyperdrive: {
		readonly webProduction: string;
		readonly edgeProduction: string;
		readonly development: string;
	};
	readonly productionRef: string;
	readonly developmentRef: string;
};

/** The files the identifiers go into; nothing else is touched. */
export const IDENTIFIER_FILES = [
	"wrangler.web.jsonc",
	"wrangler.edge-executor.jsonc",
	"scripts/deploy-production.ts",
] as const;

/**
 * One file with its placeholders replaced. In a wrangler file, a Hyperdrive
 * id before the `"env"` block is the development Worker's, inside it the
 * production Worker's. Throws when a placeholder is missing, so a changed
 * file never deploys with an identifier left out.
 */
export function withProductionIdentifiers(
	file: (typeof IDENTIFIER_FILES)[number],
	text: string,
	ids: ProductionIdentifiers,
): string {
	const replace = (input: string, from: string, to: string) => {
		if (!input.includes(from))
			throw new Error(`${file}: expected placeholder ${from}.`);
		return input.split(from).join(to);
	};
	if (file === "scripts/deploy-production.ts") {
		const constants = replace(
			text,
			`const PRODUCTION_DATABASE_REF = "${PLACEHOLDER_PRODUCTION_REF}";`,
			`const PRODUCTION_DATABASE_REF = "${ids.productionRef}";`,
		);
		return replace(
			constants,
			`const DEVELOPMENT_DATABASE_REF = "${PLACEHOLDER_DEVELOPMENT_REF}";`,
			`const DEVELOPMENT_DATABASE_REF = "${ids.developmentRef}";`,
		);
	}
	const split = text.indexOf('"env"');
	if (split < 0) throw new Error(`${file}: expected an "env" block.`);
	const production =
		file === "wrangler.web.jsonc"
			? ids.hyperdrive.webProduction
			: ids.hyperdrive.edgeProduction;
	const top = replace(
		text.slice(0, split),
		PLACEHOLDER_ACCOUNT_ID,
		ids.accountId,
	);
	const env = replace(text.slice(split), PLACEHOLDER_HYPERDRIVE_ID, production);
	return (
		(top.includes(PLACEHOLDER_HYPERDRIVE_ID)
			? top.split(PLACEHOLDER_HYPERDRIVE_ID).join(ids.hyperdrive.development)
			: top) + env
	);
}

/** A Supabase database ref from a Hyperdrive origin (pooler user `postgres.<ref>` or host `db.<ref>.supabase.co`). */
export function supabaseRef(origin: { user?: string; host?: string }) {
	const fromUser = /^postgres\.([a-z0-9]{20})$/.exec(origin.user ?? "")?.[1];
	const fromHost = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(
		origin.host ?? "",
	)?.[1];
	const ref = fromUser ?? fromHost;
	if (!ref) throw new Error("A Hyperdrive origin names no Supabase project.");
	return ref;
}

const API = "https://api.cloudflare.com/client/v4";

/** Reads the identifiers from the live account (read-only calls). */
export async function liveProductionIdentifiers(
	token: string,
	fetcher: typeof fetch = fetch,
): Promise<ProductionIdentifiers> {
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
		throw new Error(
			`The deploy token sees ${accounts.length} Cloudflare accounts; expected exactly one.`,
		);
	const accountId = accounts[0].id;
	const hyperdriveOf = async (script: string) => {
		const settings = await get<{ bindings?: { type: string; id?: string }[] }>(
			`/accounts/${accountId}/workers/scripts/${script}/settings`,
		);
		const bound = (settings.bindings ?? []).filter(
			(binding) => binding.type === "hyperdrive" && binding.id,
		);
		if (bound.length !== 1)
			throw new Error(
				`${script} is bound to ${bound.length} Hyperdrive configs.`,
			);
		const id = bound[0].id as string;
		const config = await get<{ origin?: { user?: string; host?: string } }>(
			`/accounts/${accountId}/hyperdrive/configs/${id}`,
		);
		return { id, ref: supabaseRef(config.origin ?? {}) };
	};
	const web = await hyperdriveOf("ytimesy-web-production");
	const edge = await hyperdriveOf("ytimesy-edge-executor-production");
	const development = await hyperdriveOf("ytimesy-edge-executor-development");
	if (web.ref !== edge.ref)
		throw new Error("The production Workers use different databases.");
	if (development.ref === edge.ref)
		throw new Error("The development Worker uses the production database.");
	return {
		accountId,
		hyperdrive: {
			webProduction: web.id,
			edgeProduction: edge.id,
			development: development.id,
		},
		productionRef: edge.ref,
		developmentRef: development.ref,
	};
}
