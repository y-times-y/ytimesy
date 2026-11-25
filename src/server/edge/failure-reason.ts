/** A short, bounded reason for a failure that may be a thrown Response (its status and body, not "[object Response]"). */
export async function failureReason(error: unknown, max = 300) {
	const text =
		error instanceof Response
			? `${error.status} ${await error
					.clone()
					.text()
					.catch(() => "")}`.trim()
			: error instanceof Error
				? error.message
				: String(error);
	return text.slice(0, max);
}
