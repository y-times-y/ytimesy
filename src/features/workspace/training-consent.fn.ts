import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { TRAINING_POLICY_VERSION } from "#/content/legal/versions";
import type { TrainingConsent } from "#/domain/training-consent";
import {
	dismissTrainingPrompt,
	projectTrainingExcluded,
	setProjectTrainingExcluded,
	setTrainingConsent,
	trainingConsentFor,
	trainingPromptDue,
} from "#/server/adapters/training-consent";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";

export const readTrainingConsentFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<TrainingConsent> =>
		trainingConsentFor((await requireUser(getRequest().headers)).id),
);

/**
 * Turning it on must name the policy version the user was shown, so a stale
 * page cannot record consent to a policy the user never saw. `source` is
 * "onboarding" when the choice came from the "Help improve ytimesy" card
 * (first run, or shown once to older accounts).
 */
export const trainingConsentInput = z.object({
	enabled: z.boolean(),
	policyVersion: z.string().max(64),
	source: z.enum(["settings", "onboarding"]).default("settings"),
});

export const saveTrainingConsentFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => trainingConsentInput.parse(data))
	.handler(async ({ data }): Promise<TrainingConsent> => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		if (data.enabled && data.policyVersion !== TRAINING_POLICY_VERSION)
			throw new Response("The training policy changed; reload to read it.", {
				status: 409,
			});
		await setTrainingConsent(user.id, data.enabled, data.source);
		return trainingConsentFor(user.id);
	});

/** Whether to show the "Help improve ytimesy" card to this account. */
export const readTrainingPromptFn = createServerFn({ method: "GET" }).handler(
	async () => ({
		due: await trainingPromptDue((await requireUser(getRequest().headers)).id),
	}),
);

/** The card was closed without continuing: consent stays as it is (off). */
export const dismissTrainingPromptFn = createServerFn({
	method: "POST",
}).handler(async () => {
	requireSameOrigin(getRequest());
	await dismissTrainingPrompt((await requireUser(getRequest().headers)).id);
	return { due: false };
});

const projectInput = z.object({ projectId: z.uuid() });

export const readProjectTrainingFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => projectInput.parse(data))
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		const excluded = await projectTrainingExcluded(user.id, data.projectId);
		if (excluded === null)
			throw new Response("Project is not available.", { status: 404 });
		return { excluded };
	});

export const saveProjectTrainingFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		projectInput.extend({ excluded: z.boolean() }).parse(data),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		await setProjectTrainingExcluded(user.id, data.projectId, data.excluded);
		return { excluded: data.excluded };
	});
