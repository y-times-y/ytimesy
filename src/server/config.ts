import "@tanstack/react-start/server-only";
import { z } from "zod";

const optionalSecret = z.preprocess(
	(value) => (value === "" || value == null ? undefined : value),
	z.string().min(1).optional(),
);

const configuration = z.object({
	DATABASE_POOL_MAX: z.preprocess(
		(value) => (value === "" ? undefined : value),
		z.coerce.number().int().min(1).max(20).default(2),
	),
	APP_URL: z.url(),
	BETTER_AUTH_SECRET: z.string().min(32),
	DATABASE_URL: z.string().refine((value) => {
		try {
			const url = new URL(value);
			return (
				["postgres:", "postgresql:"].includes(url.protocol) &&
				url.searchParams.get("sslmode") === "verify-full"
			);
		} catch {
			return false;
		}
	}, "Use a PostgreSQL URL with sslmode=verify-full"),
	GITHUB_OAUTH_CLIENT_ID: z.string().min(1),
	GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1),
	GITHUB_APP_CLIENT_ID: z.string().min(1),
	GITHUB_APP_CLIENT_SECRET: z.string().min(1),
	GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9-]+$/),
	GOOGLE_CLIENT_ID: optionalSecret,
	GOOGLE_CLIENT_SECRET: optionalSecret,
});
export function serverConfig() {
	const parsed = configuration.safeParse(process.env);
	if (!parsed.success)
		throw new Error(
			`Missing or invalid server configuration: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
		);
	return parsed.data;
}
