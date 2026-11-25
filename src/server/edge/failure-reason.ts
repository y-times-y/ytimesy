/** A short, bounded reason for a failure that may be a thrown Response (its status and body, not "[object Response]"). */
export async function failureReason(error: unknown, max = 300) {
	const text = isResponseLike(error)
		? `${error.status} ${await error
				.clone()
				.text()
				.catch(() => "")}`.trim()
		: error instanceof Error
			? error.message
			: String(error);
	return text.slice(0, max);
}

/** A Response from another realm (a polyfill) fails instanceof; its shape does not. */
function isResponseLike(error: unknown): error is Response {
	return (
		typeof error === "object" &&
		error !== null &&
		typeof (error as Response).status === "number" &&
		typeof (error as Response).clone === "function" &&
		typeof (error as Response).text === "function"
	);
}
