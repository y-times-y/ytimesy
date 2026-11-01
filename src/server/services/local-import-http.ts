import type { z } from "zod";
import {
	readBoundedRequestBody,
	readBoundedRequestBytes,
} from "#/domain/bounded-request-body";
import { LOCAL_IMPORT_BODY_LIMITS } from "#/domain/local-import";

/**
 * Request bodies of the CLI's /api/local-import routes: JSON under a per-route
 * limit, checked strictly, with the failing fields named (the CLI shows them).
 */
export async function readImportJson<Schema extends z.ZodType>(
	request: Request,
	schema: Schema,
	limit: number = LOCAL_IMPORT_BODY_LIMITS.json,
): Promise<z.infer<Schema>> {
	if (!request.headers.get("content-type")?.startsWith("application/json"))
		throw new Response("Send JSON (Content-Type: application/json).", {
			status: 415,
		});
	let text: string;
	try {
		text = await readBoundedRequestBody(request, limit);
	} catch (error) {
		throw new Response(
			error instanceof RangeError
				? `The request is larger than ${limit} bytes.`
				: "The request body could not be read.",
			{ status: error instanceof RangeError ? 413 : 400 },
		);
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Response("The request body is not valid JSON.", { status: 400 });
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success)
		throw new Response(
			`Invalid request: ${parsed.error.issues
				.slice(0, 5)
				.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
				.join("; ")}`,
			{ status: 400 },
		);
	return parsed.data;
}

/** A transcript archive's bytes, refused past the per-session limit. */
export async function readImportArchive(request: Request) {
	const limit = LOCAL_IMPORT_BODY_LIMITS.transcript;
	try {
		return await readBoundedRequestBytes(request, limit);
	} catch (error) {
		throw new Response(
			error instanceof RangeError
				? `A transcript archive may be at most ${limit} bytes.`
				: "The transcript could not be read.",
			{ status: error instanceof RangeError ? 413 : 400 },
		);
	}
}
