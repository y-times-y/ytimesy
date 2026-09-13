import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
	authorizedRepository,
	listBranches,
} from "../../../server/adapters/github";
import { requireUser } from "../../../server/auth/auth";
import { githubAccessToken } from "../../../server/auth/github-connection";
import { endpoint } from "../../../server/http";

const selection = z.object({
	installationId: z.coerce.number().int().positive().safe(),
	repositoryId: z.coerce.number().int().positive().safe(),
});
export const Route = createFileRoute("/api/github/branches")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () => {
					const user = await requireUser(request.headers);
					const params = selection.parse(
						Object.fromEntries(new URL(request.url).searchParams),
					);
					const token = await githubAccessToken(user.id);
					return listBranches(
						token,
						await authorizedRepository(
							token,
							params.installationId,
							params.repositoryId,
						),
					);
				}),
		},
	},
});
