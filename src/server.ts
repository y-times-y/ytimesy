import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { registerAuthEmailBinding } from "./server/adapters/email";
import { handleWorkerSocket } from "./server/sockets/worker-sockets";
import type { WebWorkerEnvironment } from "./server/web/environment";
import { withWebRequestScope } from "./server/web/request-scope";
import { withSecurityHeaders } from "./server/web/security-headers";

type WorkerContext = { waitUntil(work: Promise<unknown>): void };

/**
 * On Cloudflare every request gets its own database scope; on the local Node dev
 * server (no bindings) requests go straight to the TanStack handler.
 */
export default createServerEntry({
	async fetch(request, ...rest) {
		const [env, context] = rest as unknown as [
			WebWorkerEnvironment | undefined,
			WorkerContext | undefined,
		];
		if (!env?.HYPERDRIVE || !context)
			return withSecurityHeaders(await handler.fetch(request));
		registerAuthEmailBinding(env.EMAIL);
		return withWebRequestScope(
			env,
			(work) => context.waitUntil(work),
			async () =>
				withSecurityHeaders(
					await (handleWorkerSocket(request) ?? handler.fetch(request)),
				),
		);
	},
});
