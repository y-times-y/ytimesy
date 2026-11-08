/** A credential found in a message the user typed, named for the project secret it becomes. */
export type PastedSecret = { readonly name: string; readonly value: string };

const KNOWN_TOKEN_FORMATS: readonly { name: string; pattern: RegExp }[] = [
	{ name: "ANTHROPIC_API_KEY", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{ name: "OPENAI_API_KEY", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{32,}/g },
	{
		name: "GITHUB_TOKEN",
		pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g,
	},
	{ name: "SLACK_TOKEN", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
	{ name: "AWS_ACCESS_KEY_ID", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{ name: "STRIPE_SECRET_KEY", pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}/g },
	{ name: "GOOGLE_API_KEY", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
	{ name: "NPM_TOKEN", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
];

/** `SOME_API_KEY=value`, as pasted from a .env file or a shell export. */
const NAMED_ASSIGNMENT =
	/\b([A-Z][A-Z0-9_]{0,63}(?:KEY|TOKEN|SECRET|PASSWORD))=(["']?)([^\s"']{8,})\2/g;

/**
 * Finds credentials in a message: well-known token formats and
 * NAME_KEY=value assignments. Distinct values sharing a name get _2, _3, ...
 */
export function findPastedSecrets(text: string): PastedSecret[] {
	const found: PastedSecret[] = [];
	const add = (name: string, value: string) => {
		if (found.some((secret) => secret.value === value)) return;
		const taken = found.filter((secret) => secret.name.startsWith(name));
		found.push({
			name: taken.length ? `${name}_${taken.length + 1}` : name,
			value,
		});
	};
	for (const match of text.matchAll(NAMED_ASSIGNMENT))
		add(match[1] ?? "", match[3] ?? "");
	for (const { name, pattern } of KNOWN_TOKEN_FORMATS)
		for (const match of text.matchAll(pattern)) add(name, match[0]);
	return found.filter((secret) => secret.name);
}

/** The message with each saved value swapped for the variable that now holds it. */
export function messageWithSecretsAsVariables(
	text: string,
	saved: readonly PastedSecret[],
) {
	let result = text;
	for (const { name, value } of [...saved].sort(
		(a, b) => b.value.length - a.value.length,
	))
		result = result.split(value).join(`$${name}`);
	return saved.length
		? `${result}\n\n(Secrets in this message were saved to the project as environment variables: ${saved.map((secret) => `$${secret.name}`).join(", ")}. They are available in every chat of this project.)`
		: result;
}
