export type DevelopmentSessionTarget = {
	readonly secret: string;
	readonly userId: string;
};

export function developmentSessionTarget(config: {
	readonly DEV_AUTH_BYPASS_SECRET?: string;
	readonly DEV_AUTH_USER_ID?: string;
}): DevelopmentSessionTarget | null {
	const secret = config.DEV_AUTH_BYPASS_SECRET?.trim() ?? "";
	const userId = config.DEV_AUTH_USER_ID?.trim() ?? "";
	if (secret.length < 32 || userId.length === 0) return null;
	return { secret, userId };
}

export function providedDevelopmentSessionSecret(
	querySecret: string | null | undefined,
	headerSecret: string | null | undefined,
): string | undefined {
	const query = querySecret?.trim();
	if (query) return query;
	const header = headerSecret?.trim();
	return header || undefined;
}

export function developmentSessionSecretMatches(
	expected: string,
	provided: string | null | undefined,
): boolean {
	if (!provided) return false;
	const left = Buffer.from(expected);
	const right = Buffer.from(provided);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

function timingSafeEqual(left: Buffer, right: Buffer): boolean {
	if (left.length !== right.length) return false;
	let mismatch = 0;
	for (let index = 0; index < left.length; index += 1) {
		mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return mismatch === 0;
}
