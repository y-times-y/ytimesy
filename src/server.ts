import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { captureServerException } from "./server/adapters/analytics";
import { registerAuthEmailBinding } from "./server/adapters/email";
import { registerMemoryRepos } from "./server/adapters/memory-repos";
import { handleLiveProgressSocket } from "./server/sockets/live-progress-socket";
import { handleWorkerSocket } from "./server/sockets/worker-sockets";
import { proxyAnalytics } from "./server/web/analytics-proxy";
import { canonicalOriginRedirect } from "./server/web/canonical-origin";
import { EARLY_HINT_LINKS } from "./server/web/early-hints";
import type { WebWorkerEnvironment } from "./server/web/environment";
import { withWebRequestScope } from "./server/web/request-scope";
import { limitRequestBody } from "./server/web/request-size";
import { withSecurityHeaders } from "./server/web/security-headers";
import { serverFnOriginRejection } from "./server/web/server-fn-origin";

type WorkerContext = { waitUntil(work: Promise<unknown>): void };

/**
 * On Cloudflare every request gets its own database scope; on the local Node dev
 * server (no bindings) requests go straight to the TanStack handler.
 */
/**
 * Server errors go to PostHog error tracking: thrown errors, and 5xx
 * responses (server functions turn their errors into those). Only the method
 * and path are recorded, never the query or body.
 */
async function monitored(
	request: Request,
	handle: () => Response | Promise<Response>,
): Promise<Response> {
	const where = () => {
		const { pathname } = new URL(request.url);
		return { method: request.method, path: pathname.slice(0, 200) };
	};
	try {
		const response = await handle();
		if (response.status >= 500)
			void captureServerException(
				new Error(`HTTP ${response.status} from ${request.method} route`),
				{ source: "web", properties: { ...where(), status: response.status } },
			);
		return response;
	} catch (error) {
		void captureServerException(error, { source: "web", properties: where() });
		throw error;
	}
}

/** Pages answer with Link headers that Cloudflare turns into 103 Early Hints. */
function renderPage(request: Request) {
	return handler.fetch(request, { responseLinkHeader: EARLY_HINT_LINKS });
}

export default createServerEntry({
	async fetch(incoming, ...rest) {
		const [env, context] = rest as unknown as [
			WebWorkerEnvironment | undefined,
			WorkerContext | undefined,
		];
		const redirect = canonicalOriginRedirect(incoming, process.env.APP_URL);
		if (redirect) return redirect;
		const crossOrigin = serverFnOriginRejection(incoming, process.env.APP_URL);
		if (crossOrigin) return withSecurityHeaders(crossOrigin);
		const request = limitRequestBody(incoming);
		if (request instanceof Response) return withSecurityHeaders(request);
		// Browser analytics through our own origin (no database, no app render).
		const analytics = await proxyAnalytics(request);
		if (analytics) return analytics;
		if (!env?.HYPERDRIVE || !context)
			return withSecurityHeaders(
				await monitored(request, () => renderPage(request)),
				request,
			);
		registerAuthEmailBinding(env.EMAIL);
		registerMemoryRepos(env.ARTIFACTS);
		return withWebRequestScope(
			env,
			(work) => context.waitUntil(work),
			async () =>
				withSecurityHeaders(
					await monitored(
						request,
						async () =>
							(await handleWorkerSocket(request)) ??
							(await handleLiveProgressSocket(request)) ??
							renderPage(request),
					),
					request,
				),
			`${request.method} ${new URL(request.url).pathname}`,
		);
	},
});
