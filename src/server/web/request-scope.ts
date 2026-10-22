import { withAfterResponse } from "../adapters/after-response";
import { withCodexSubscriptionEgress } from "../adapters/codex-subscription-transport";
import { withDatabaseScope } from "../adapters/database-scope";
import { withExecutorBinding } from "../adapters/executor-fetch";
import { withEdgeModelEndpoints } from "../edge/model-endpoint";
import type { WebWorkerEnvironment } from "./environment";

/**
 * Runs one web request with its own Hyperdrive connection, egress and model
 * transport. The scope stays open until the response body has finished
 * streaming (SSR, server-sent progress) and work it started to finish after
 * its response (startAfterResponse) has settled, then its connections close;
 * nothing is shared with another request.
 */
export function withWebRequestScope(
	env: WebWorkerEnvironment,
	waitUntil: (work: Promise<unknown>) => void,
	handle: () => Promise<Response>,
): Promise<Response> {
	return new Promise<Response>((respond, fail) => {
		let responded = false;
		const after: Promise<unknown>[] = [];
		const work = withDatabaseScope(
			env.HYPERDRIVE.connectionString,
			() =>
				withCodexSubscriptionEgress(
					(input, options) => env.CODEX_EGRESS.fetch(input, options),
					() =>
						withExecutorBinding(
							(input, init) => env.EXECUTOR.fetch(input, init),
							() =>
								withEdgeModelEndpoints(() =>
									withAfterResponse(
										(pending) => {
											after.push(pending);
										},
										async () => {
											try {
												const response = await handle();
												if (!response.body || response.webSocket) {
													responded = true;
													respond(response);
													return;
												}
												const { readable, writable } = new TransformStream();
												responded = true;
												respond(
													new Response(readable, {
														status: response.status,
														statusText: response.statusText,
														headers: response.headers,
													}),
												);
												await response.body
													.pipeTo(writable)
													.catch(() => undefined);
											} finally {
												// Work started for after the response (a turn's
												// dispatch) keeps this request's scope open.
												while (after.length)
													await Promise.allSettled(after.splice(0));
											}
										},
									),
								),
						),
				),
			null,
		);
		work.catch((error) => {
			if (!responded) fail(error);
		});
		waitUntil(work.catch(() => undefined));
	});
}
