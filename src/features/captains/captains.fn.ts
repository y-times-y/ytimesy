import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { type Captain, parseCaptainInput } from "#/domain/captain";
import {
	archiveCaptainRow,
	createCaptain,
	listCaptains,
	renameLeader,
	updateCaptain,
} from "#/server/adapters/captains";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import { cancelServerTurn } from "#/server/services/cancel-server-turn";

const projectInput = z.object({ projectId: z.uuid() });
const captainInput = z.object({ captainId: z.uuid() });

export type CaptainResponse =
	| { readonly ok: true; readonly captain: Captain }
	| { readonly ok: false; readonly error: string };

/** The project's live captains with what their chats are doing: one read, no transcript. */
export const listCaptainsFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => projectInput.parse(data))
	.handler(async ({ data }): Promise<readonly Captain[]> => {
		const user = await requireUser(getRequest().headers).catch(() => null);
		if (!user) return [];
		return listCaptains(user.id, data.projectId);
	});

export const createCaptainFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		projectInput.extend({ captain: z.unknown() }).parse(data),
	)
	.handler(async ({ data }): Promise<CaptainResponse> => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		const parsed = parseCaptainInput(data.captain);
		if (!parsed.ok) return parsed;
		return createCaptain(user.id, data.projectId, parsed.value);
	});

export const updateCaptainFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		captainInput.extend({ captain: z.unknown() }).parse(data),
	)
	.handler(async ({ data }): Promise<CaptainResponse> => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		const parsed = parseCaptainInput(data.captain);
		if (!parsed.ok) return parsed;
		return updateCaptain(user.id, data.captainId, parsed.value);
	});

/** Deletes a captain: row and chat are archived (nothing is destroyed) and a running turn is stopped. */
export const deleteCaptainFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => captainInput.parse(data))
	.handler(async ({ data }): Promise<{ readonly ok: boolean }> => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		const gone = await archiveCaptainRow(user.id, data.captainId);
		if (!gone) return { ok: false };
		// The row and its chat are archived; stop a turn that was running.
		await cancelServerTurn(user.id, gone.chatId).catch((error: unknown) =>
			console.warn("captain.cancel_failed", (error as Error).message),
		);
		return { ok: true };
	});

/** The leader's display name; an empty name goes back to "Super agent". */
export const renameLeaderFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		projectInput.extend({ name: z.string().max(80) }).parse(data),
	)
	.handler(
		async ({
			data,
		}): Promise<{ readonly ok: boolean; readonly error?: string }> => {
			requireSameOrigin(getRequest());
			const user = await requireUser(getRequest().headers);
			const parsed = parseCaptainInput({
				name: data.name || "x",
				color: "#d97757",
			});
			if (data.name && !parsed.ok) return { ok: false, error: parsed.error };
			const name = data.name && parsed.ok ? parsed.value.name : null;
			const done = await renameLeader(user.id, data.projectId, name);
			return done
				? { ok: true }
				: { ok: false, error: "A captain already has that name." };
		},
	);
