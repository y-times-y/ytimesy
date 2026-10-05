/** Limit bytes while reading requests or responses, including dishonest Content-Length values. */
export async function readBoundedRequestBody(
	request: Pick<Request, "body">,
	maximumBytes: number,
) {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > maximumBytes)
				throw new RangeError("Request payload too large.");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
		body,
	);
}
