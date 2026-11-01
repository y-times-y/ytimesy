import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { endpoint } from "#/server/http";
import {
	importTranscript,
	requireImportCaller,
} from "#/server/services/local-import";
import { readImportArchive } from "#/server/services/local-import-http";

const target = z.object({ session: z.uuid() }).strict();

/** A session's full transcript: a gzip tar of transcript.md and its images (25 MB at most). */
export const Route = createFileRoute("/api/local-import/transcript")({
	server: {
		handlers: {
			PUT: ({ request }) =>
				endpoint(async () => {
					const caller = await requireImportCaller(request);
					const { session } = target.parse(
						Object.fromEntries(new URL(request.url).searchParams),
					);
					return importTranscript(
						caller,
						session,
						await readImportArchive(request),
					);
				}),
		},
	},
});
