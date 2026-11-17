/**
 * A turn runner box holds NO production secret (docs/turn-runner-boxes.md):
 * no database URL, provider key, vault key or workspace/GitHub credential.
 * It reaches everything through the edge with a short-lived identity. A box
 * started with any of these in its environment is misconfigured (it would be
 * the one box a leak exposes), so it refuses to run and says which names
 * (never their values) were present.
 */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
	// Database.
	"DATABASE_URL",
	"DIRECT_URL",
	"DATABASE_SSL_CA",
	"YTIMESY_DATABASE_VIA_HYPERDRIVE",
	"POSTGRES_URL",
	"POSTGRES_PASSWORD",
	"PGPASSWORD",
	"PGHOST",
	"PGUSER",
	"PGDATABASE",
	// Vault, signing and relay secrets.
	"TOKEN_VAULT_KEY",
	"YTIMESY_SECRETS_KEY",
	"BETTER_AUTH_SECRET",
	"YTIMESY_REALTIME_SECRET",
	"YTIMESY_CODEX_RELAY_SECRET",
	"YTIMESY_CLAUDE_BOX_TOOLS_SECRETS",
	"TURN_BOX_EDGE_PRIVATE_KEY",
	"GITHUB_PR_REPAIR_WEBHOOK_SECRET",
	// Model providers.
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"XAI_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	// Workspace, storage, analytics, cloud.
	"FREESTYLE_API_KEY",
	"SUPABASE_STORAGE_SERVICE_KEY",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"POSTHOG_PERSONAL_API_KEY",
	"POSTHOG_PROJECT_TOKEN",
	"CLOUDFLARE_API_TOKEN",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
]);

/** Names that look like a secret even when this list has not caught up with a new one. */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
	/_API_KEY$/,
	/_SECRET$/,
	/_SECRET_KEY$/,
	/_PRIVATE_KEY$/,
	/^GITHUB_APP_/,
	/^(DATABASE|POSTGRES|POSTGRESQL)_/,
];

/** Names a box may hold although they look secret-like: its own identity and the edge's PUBLIC key. */
const ALLOWED_NAMES: ReadonlySet<string> = new Set([
	"YTIMESY_BOX_IDENTITY",
	"TURN_BOX_EDGE_PUBLIC_KEY",
]);

export class TurnBoxHoldsSecrets extends Error {
	constructor(readonly names: readonly string[]) {
		super(
			`Refusing to start: this turn runner box has production secrets in its environment (${names.join(", ")}). ` +
				"A box holds no database URL, provider key or vault key; it reaches them through the edge. Remove them and start it again.",
		);
		this.name = "TurnBoxHoldsSecrets";
	}
}

/** The secret-bearing variables set (non-empty) in `env`, by name. */
export function turnBoxForbiddenEnv(
	env: Readonly<Record<string, string | undefined>>,
): string[] {
	return Object.entries(env)
		.filter(([name, value]) => {
			if (!value?.trim() || ALLOWED_NAMES.has(name)) return false;
			return (
				FORBIDDEN_NAMES.has(name) ||
				FORBIDDEN_PATTERNS.some((pattern) => pattern.test(name))
			);
		})
		.map(([name]) => name)
		.sort();
}

/** Throws TurnBoxHoldsSecrets when the box's environment holds any secret. */
export function assertTurnBoxHoldsNoSecrets(
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	const names = turnBoxForbiddenEnv(env);
	if (names.length) throw new TurnBoxHoldsSecrets(names);
}
