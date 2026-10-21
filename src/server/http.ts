import { z } from "zod";
import { captureServerException } from "./adapters/analytics";
import { authTrustedOrigins } from "./auth/providers";
import { serverConfig } from "./config";
export function requireSameOrigin(request: Request) {
	const origin = request.headers.get("origin");
	if (!origin || !authTrustedOrigins(serverConfig().APP_URL).includes(origin))
		throw new Response("Request origin is not allowed.", { status: 403 });
	if (!request.headers.get("content-type")?.startsWith("application/json"))
		throw new Response("JSON required.", { status: 415 });
}
export async function endpoint(
	operation: () => Promise<unknown>,
): Promise<Response> {
	try {
		return Response.json(await operation(), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		if (error instanceof Response) return error;
		if (error instanceof z.ZodError)
			return Response.json({ error: "Invalid request." }, { status: 400 });
		const status =
			typeof error === "object" && error !== null && "status" in error
				? error.status
				: null;
		if (status === 401 || status === 403)
			return Response.json(
				{ error: "GitHub access expired or was denied. Reconnect GitHub." },
				{ status: 409 },
			);
		// Provider exceptions can contain credentials in request headers; never
		// log them. Error tracking gets a redacted copy.
		void captureServerException(error, { source: "api" });
		return Response.json(
			{
				error:
					"The request could not be completed. Please retry or reconnect GitHub.",
			},
			{ status: 502 },
		);
	}
}
