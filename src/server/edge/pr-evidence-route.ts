import { evidencePathFromRequest } from "#/domain/pr-evidence";
import { getEvidenceFile } from "../adapters/pr-evidence-store";

export const PR_EVIDENCE_ROUTE_PREFIX = "/pr-evidence/";

/**
 * Read-only media for pull request descriptions: GET/HEAD of
 * `/pr-evidence/<32 hex id>/<file>.(png|webm|txt|json)`, nothing else. The
 * response cannot run script or be framed.
 */
export async function servePrEvidence(
	request: Request,
	fetchFile: typeof getEvidenceFile = getEvidenceFile,
) {
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
	const path = new URL(request.url).pathname;
	const target = evidencePathFromRequest(
		path.slice(PR_EVIDENCE_ROUTE_PREFIX.length),
	);
	if (!path.startsWith(PR_EVIDENCE_ROUTE_PREFIX) || !target)
		return new Response(null, { status: 404 });
	const stored = await fetchFile(target.key, request.headers.get("range"));
	if (!stored) return new Response(null, { status: 503 });
	if (stored.status !== 200 && stored.status !== 206)
		return new Response(null, {
			status: stored.status === 416 ? 416 : 404,
		});
	const headers = new Headers({
		"content-type": target.contentType,
		"cache-control": "public, max-age=31536000, immutable",
		"x-content-type-options": "nosniff",
		"content-security-policy": "default-src 'none'; sandbox",
		"cross-origin-resource-policy": "cross-origin",
		"referrer-policy": "no-referrer",
		"accept-ranges": "bytes",
	});
	for (const name of ["content-length", "content-range", "etag"]) {
		const value = stored.headers.get(name);
		if (value) headers.set(name, value);
	}
	return new Response(request.method === "HEAD" ? null : stored.body, {
		status: stored.status,
		headers,
	});
}
