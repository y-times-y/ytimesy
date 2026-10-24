import { redactSecrets } from "#/domain/project-workspace";

/**
 * Runs a server function's work so that a failure reaches the browser only
 * as `publicFailure` words it; the real error (secrets redacted) is logged
 * on the server.
 */
export async function withPublicFailure<A>(
	operation: string,
	publicFailure: (error: unknown) => string,
	run: () => Promise<A>,
): Promise<A> {
	try {
		return await run();
	} catch (error) {
		console.error(`${operation} failed.`, {
			name: error instanceof Error ? error.name : typeof error,
			message: redactSecrets(
				error instanceof Error ? error.message : String(error),
			),
			stack: error instanceof Error ? redactSecrets(error.stack ?? "") : "",
		});
		throw new Error(publicFailure(error));
	}
}
