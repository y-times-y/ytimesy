/**
 * The production deploy values, shared with every project as the account
 * secret PRODUCTION_ENV_FILE. A chat receives a secret as one environment
 * variable, so the env file arrives with its line breaks flattened onto one
 * line, followed by `# comments`, and its database URL names a certificate
 * path from the machine that wrote it. This turns it back into the file
 * scripts/deploy-production.ts reads.
 */
const NAME = /[A-Z][A-Z0-9_]{2,}/;

/** Where each `NAME=` starts: at the start, after whitespace, or after a literal \n. */
function assignments(text: string) {
	const found = [
		...text.matchAll(
			new RegExp(`(?:(?<=\\s)|^|(?<=\\\\n)|(?<=;))(${NAME.source})=`, "g"),
		),
	];
	return found.map((match, index) => ({
		name: match[1],
		value: text.slice(
			(match.index ?? 0) + match[0].length,
			found[index + 1]?.index ?? text.length,
		),
	}));
}

/**
 * A quoted value runs to its closing quote and keeps its escapes (the GitHub
 * key is one line with \n inside); an unquoted one is its first word. Anything
 * after that is a comment.
 */
function entryValue(raw: string): string {
	const text = raw.trim();
	const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(text);
	return quoted ? `"${quoted[1]}"` : (text.split(/\s+/)[0] ?? "");
}

export function parseProductionEnvSecret(
	text: string,
): ReadonlyMap<string, string> {
	const entries = new Map<string, string>();
	for (const { name, value } of assignments(text)) {
		const parsed = entryValue(value);
		if (parsed) entries.set(name, parsed);
	}
	return entries;
}

/** A database URL's `sslrootcert` points at this machine's copy of the certificate. */
export function withCertificatePath(url: string, certificatePath: string) {
	return url.replace(/sslrootcert=[^&"]*/, `sslrootcert=${certificatePath}`);
}

export function productionEnvFileText(
	entries: ReadonlyMap<string, string>,
	certificatePath: string,
): string {
	return [...entries]
		.map(([name, value]) =>
			name === "DATABASE_URL"
				? `${name}=${withCertificatePath(value, certificatePath)}`
				: `${name}=${value}`,
		)
		.join("\n")
		.concat("\n");
}
