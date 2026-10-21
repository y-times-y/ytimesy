import { MESSAGE_ATTACHMENT_LIMITS } from "#/domain/message-attachment";

/**
 * The largest request body the web Worker reads: a message carrying the
 * maximum attachments as base64 JSON, plus room for its text and fields.
 */
export const MAX_REQUEST_BODY_BYTES =
	Math.ceil((MESSAGE_ATTACHMENT_LIMITS.totalBytes * 4) / 3) + 4 * 1024 * 1024;

/**
 * A 413 when the declared length is over the limit; otherwise the request,
 * with a body that fails once more than the limit arrives when no length
 * was declared (chunked uploads).
 */
export function limitRequestBody(
	request: Request,
	limit = MAX_REQUEST_BODY_BYTES,
): Request | Response {
	if (!request.body) return request;
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (!/^\d+$/.test(declared) || length > limit)
			return new Response(null, { status: 413 });
		return request;
	}
	let received = 0;
	const counted = request.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				received += chunk.byteLength;
				if (received > limit)
					controller.error(new Error("Request body is too large."));
				else controller.enqueue(chunk);
			},
		}),
	);
	return new Request(request, {
		body: counted,
		duplex: "half",
	} as RequestInit);
}
