/**
 * Postgres `jsonb` rejects the NUL character (`\u0000`: "unsupported Unicode
 * escape sequence"), which a command's output carries whenever it prints
 * binary data (`cat` of an executable). One such tool result used to fail
 * the whole tool call and lose its output. Every string NUL becomes U+FFFD,
 * the replacement character, before the value is serialized for a jsonb
 * column; the rest of the output is kept.
 */
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

export function withoutNul(text: string) {
	return text.includes(NUL) ? text.replaceAll(NUL, REPLACEMENT) : text;
}

/** JSON.stringify for a jsonb parameter: NUL-free strings and object keys. */
export function jsonbText(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) => {
		if (typeof item === "string") return withoutNul(item);
		if (
			item &&
			typeof item === "object" &&
			!Array.isArray(item) &&
			Object.keys(item).some((name) => name.includes(NUL))
		)
			return Object.fromEntries(
				Object.entries(item).map(([name, entry]) => [withoutNul(name), entry]),
			);
		return item;
	});
}
