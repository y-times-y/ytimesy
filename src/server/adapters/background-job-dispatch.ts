import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac } from "node:crypto";
import { type BackgroundJob, backgroundJob } from "#/domain/background-job";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import { executorFetch } from "./executor-fetch";

type Dispatch = (job: BackgroundJob) => Promise<void>;
const binding = new AsyncLocalStorage<Dispatch>();

/** Convert an existing idempotency key into a bounded background job identity. */
export function backgroundJobId(key: string) {
	const hash = createHash("sha256")
		.update(`ytimesy:background-job:v1:${key}`)
		.digest("hex");
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Edge invocations use the binding directly; web servers use signed admission. */
export function withBackgroundJobDispatcher<T>(
	dispatch: Dispatch,
	run: () => Promise<T>,
) {
	return binding.run(dispatch, run);
}

/** Inside an edge invocation (or the rehearsal's edge): jobs go to its binding. */
export function hasInternalJobDispatcher() {
	return binding.getStore() !== undefined;
}

/**
 * The edge executor's admission origin and signing key, or null when none is
 * configured. A misconfigured one throws: it must never be silently skipped.
 */
export function backgroundAdmissionEndpoint(): {
	origin: URL;
	secret: string;
} | null {
	const endpoint = process.env.YTIMESY_BACKGROUND_WORKFLOW_URL;
	if (!endpoint) return null;
	const origin = new URL(endpoint);
	const root = process.env.BETTER_AUTH_SECRET;
	const secret =
		process.env.YTIMESY_BACKGROUND_WORKFLOW_SECRET ||
		(root && root.length >= 32
			? createHmac("sha256", root)
					.update("ytimesy:background-workflows:development:v1")
					.digest("hex")
			: undefined);
	if (
		origin.protocol !== "https:" ||
		origin.pathname !== "/" ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		!secret ||
		secret.length < 32
	)
		throw new Error(
			"Background job admission requires an HTTPS origin and signing secret.",
		);
	return { origin, secret };
}

export async function dispatchBackgroundJob(
	value: BackgroundJob,
): Promise<boolean> {
	const job = backgroundJob.parse(value);
	const internal = binding.getStore();
	if (internal) {
		await internal(job);
		return true;
	}
	const endpoint = backgroundAdmissionEndpoint();
	if (!endpoint) return false;
	const { origin, secret } = endpoint;
	const url = new URL("/jobs/start", origin).href;
	const body = JSON.stringify(job);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const response = await executorFetch(url, {
				method: "POST",
				body,
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
				headers: {
					...(await signDeliveryRequest(secret, "POST", url, body)),
					"content-type": "application/json",
				},
			});
			if (!response.ok) throw new Error("Background admission failed.");
			return true;
		} catch {
			if (attempt === 1)
				throw new Error(
					"Background admission is uncertain; the same job ID must be reused.",
				);
		}
	}
	return false;
}
