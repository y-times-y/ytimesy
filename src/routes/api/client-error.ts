import { createFileRoute } from "@tanstack/react-router";

/**
 * A browser's report of an error the app's error screen showed
 * (features/app/app-status.tsx): the message and stack, the path and build,
 * never page data. Logged for Workers observability; no session, no database.
 */
const cut = (value: unknown, max: number) =>
	typeof value === "string" ? value.slice(0, max) : "";

export const Route = createFileRoute("/api/client-error")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const text = await request.text().catch(() => "");
				if (text.length > 16_000) return new Response(null, { status: 413 });
				let body: Record<string, unknown> = {};
				try {
					body = JSON.parse(text) as Record<string, unknown>;
				} catch {
					return new Response(null, { status: 400 });
				}
				console.warn("client.error", {
					message: cut(body.message, 300),
					stack: cut(body.stack, 3_000),
					path: cut(body.path, 200).replace(/[?#].*$/, ""),
					build: cut(body.build, 64),
				});
				return new Response(null, { status: 204 });
			},
		},
	},
});
