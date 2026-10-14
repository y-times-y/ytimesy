/** RFC 6455 caps a close frame's reason at 123 UTF-8 bytes; Workers and `ws` throw past it. */
export const MAX_CLOSE_REASON_BYTES = 123;

/** Truncates a WebSocket close reason to the protocol limit on a code-point boundary. */
export function webSocketCloseReason(reason: string | undefined) {
	if (reason === undefined) return undefined;
	const encoder = new TextEncoder();
	if (encoder.encode(reason).length <= MAX_CLOSE_REASON_BYTES) return reason;
	const ellipsis = "…";
	const budget = MAX_CLOSE_REASON_BYTES - encoder.encode(ellipsis).length;
	let bytes = 0;
	let kept = "";
	for (const character of reason) {
		const size = encoder.encode(character).length;
		if (bytes + size > budget) break;
		bytes += size;
		kept += character;
	}
	return `${kept}${ellipsis}`;
}
