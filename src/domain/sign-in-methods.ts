/** How someone signs in to ytimesy, from their Better Auth account rows. */
export type SignInMethod = "email" | "github" | "google";

const ORDER: readonly SignInMethod[] = ["github", "google", "email"];

export const SIGN_IN_METHOD_LABELS: Record<SignInMethod, string> = {
	email: "Email and password",
	github: "GitHub",
	google: "Google",
};

/** Better Auth provider ids ("credential" is email and password), deduplicated and ordered. */
export function signInMethods(
	providerIds: readonly string[],
): readonly SignInMethod[] {
	const found = new Set(
		providerIds.map((id) => (id === "credential" ? "email" : id)),
	);
	return ORDER.filter((method) => found.has(method));
}

/** "Member since November 2026". */
export function memberSince(createdAt: string | Date, locale?: string) {
	const date = new Date(createdAt);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleDateString(locale ?? "en-US", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
}
