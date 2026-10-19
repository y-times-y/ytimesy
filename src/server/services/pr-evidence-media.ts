import { evidenceContentType, evidenceFileName } from "#/domain/pr-evidence";
import { evidenceForOwner } from "../adapters/pr-evidence-records";
import {
	type EvidenceStore,
	evidenceObjectKey,
	r2EvidenceStore,
} from "../adapters/pr-evidence-store";
import { requireUser } from "../auth/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** One byte range only (what media elements send); anything else gets the whole file. */
const SINGLE_RANGE = /^bytes=(\d{1,15})?-(\d{1,15})?$/;

type MediaDependencies = {
	user(headers: Headers): Promise<{ id: string }>;
	record: typeof evidenceForOwner;
	store: EvidenceStore;
};

const defaults: MediaDependencies = {
	user: requireUser,
	record: evidenceForOwner,
	store: r2EvidenceStore,
};

const notFound = () =>
	new Response(null, {
		status: 404,
		headers: { "cache-control": "no-store" },
	});

/**
 * Evidence media for the signed-in owner of the project, streamed from
 * private storage: GET/HEAD only, one byte range for video seeking, never
 * cached by shared caches, never sniffed or run as a document. A capture that
 * is not the viewer's answers 404, like one that does not exist.
 */
export async function serveEvidenceMedia(
	request: Request,
	params: { projectId: string; evidenceId: string; file: string },
	deps: MediaDependencies = defaults,
) {
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
	let user: { id: string };
	try {
		user = await deps.user(request.headers);
	} catch (error) {
		if (error instanceof Response)
			return new Response(null, {
				status: error.status,
				headers: { "cache-control": "no-store" },
			});
		throw error;
	}
	const contentType = evidenceContentType(params.file);
	if (
		!UUID.test(params.projectId) ||
		!UUID.test(params.evidenceId) ||
		!evidenceFileName(params.file) ||
		!contentType
	)
		return notFound();
	const record = await deps.record(
		user.id,
		params.projectId,
		params.evidenceId,
	);
	if (!record?.files.some((file) => file.name === params.file))
		return notFound();
	const range = request.headers.get("range");
	const stored = await deps.store.get(
		evidenceObjectKey(
			{ userId: user.id, projectId: params.projectId },
			params.evidenceId,
			params.file,
		),
		range && SINGLE_RANGE.test(range) && range !== "bytes=-" ? range : null,
	);
	const headers = new Headers({
		"content-type": contentType,
		"cache-control": "private, no-store",
		"x-content-type-options": "nosniff",
		"content-security-policy": "default-src 'none'; sandbox",
		"cross-origin-resource-policy": "same-origin",
		"referrer-policy": "no-referrer",
		"content-disposition": `inline; filename="${params.file}"`,
		"accept-ranges": "bytes",
	});
	if (stored.status === 416) {
		const total = stored.headers.get("content-range");
		if (total) headers.set("content-range", total);
		await stored.body?.cancel();
		return new Response(null, { status: 416, headers });
	}
	if (stored.status !== 200 && stored.status !== 206) {
		await stored.body?.cancel();
		return notFound();
	}
	for (const name of [
		"content-length",
		"content-range",
		"etag",
		"last-modified",
	]) {
		const value = stored.headers.get(name);
		if (value) headers.set(name, value);
	}
	if (request.method === "HEAD") await stored.body?.cancel();
	return new Response(request.method === "HEAD" ? null : stored.body, {
		status: stored.status,
		headers,
	});
}
