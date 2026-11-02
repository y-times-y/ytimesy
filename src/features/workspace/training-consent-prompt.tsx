import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Switch } from "#/components/ui/switch";
import { TRAINING_POLICY_VERSION } from "#/content/legal/versions";
import { useTrainingChoiceDefault } from "../app/privacy-region";
import { authClient } from "../auth/client";
import { useLegalPromptPending } from "../auth/legal-acceptance-prompt";
import {
	dismissTrainingPromptFn,
	readTrainingPromptFn,
	saveTrainingConsentFn,
} from "./training-consent.fn";
import { TrainingLearnMore } from "./training-consent-settings";

/** Same key as Settings, Privacy (training-consent-settings.tsx). */
const CONSENT_KEY = ["training-consent"];
const PROMPT_KEY = (userId: string | undefined) => ["training-prompt", userId];

/**
 * The "Help improve ytimesy" choice: starts on (off in the EU/UK, see
 * useTrainingChoiceDefault) until the user changes it here.
 * Showing it records nothing; only Continue does (useTrainingChoiceSave).
 */
export function TrainingChoice(props: {
	readonly enabled: boolean;
	readonly onChange: (enabled: boolean) => void;
	readonly disabled?: boolean;
}) {
	return (
		<div className="flex items-start gap-4 rounded-lg border bg-background/40 p-4 text-sm">
			<div className="flex flex-1 flex-col gap-1">
				<label
					htmlFor="training-choice"
					className="font-medium text-foreground"
				>
					Help improve ytimesy
				</label>
				<span className="text-muted-foreground">
					<TrainingLearnMore />
				</span>
				<span className="text-xs text-muted-foreground">
					You can change this anytime in Settings → Privacy.
				</span>
			</div>
			<Switch
				id="training-choice"
				checked={props.enabled}
				disabled={props.disabled}
				onCheckedChange={props.onChange}
				className="mt-0.5"
			/>
		</div>
	);
}

/**
 * Records the shown choice (on or off) with the policy version on screen,
 * source "onboarding". Nothing is written before this runs.
 */
export function useTrainingChoiceSave(userId: string | undefined) {
	const save = useServerFn(saveTrainingConsentFn);
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (enabled: boolean) =>
			save({
				data: {
					enabled,
					policyVersion: TRAINING_POLICY_VERSION,
					source: "onboarding",
				},
			}),
		onSuccess: (consent) => {
			queryClient.setQueryData(CONSENT_KEY, consent);
			queryClient.setQueryData(PROMPT_KEY(userId), { due: false });
		},
	});
}

function useTrainingPrompt() {
	const session = authClient.useSession();
	const userId = session.data?.user.id;
	const read = useServerFn(readTrainingPromptFn);
	const prompt = useQuery({
		queryKey: PROMPT_KEY(userId),
		queryFn: () => read(),
		enabled: Boolean(userId),
		staleTime: Number.POSITIVE_INFINITY,
	});
	return { session, userId, prompt };
}

/** Whether the training card shows or may be about to: other prompts wait. */
export function useTrainingPromptPending(): boolean {
	const { session, userId, prompt } = useTrainingPrompt();
	if (session.isPending) return true;
	if (!userId || prompt.isError) return false;
	return prompt.isPending || prompt.data?.due === true;
}

/**
 * Shown once to an account that never set training consent (accounts from
 * before the first-run card). Continue records the choice; closing it records
 * no consent (it stays off) and only remembers that the card was seen. Waits
 * for the Terms notice, so one prompt shows at a time.
 */
export function TrainingConsentPrompt() {
	const { userId, prompt } = useTrainingPrompt();
	const legalPending = useLegalPromptPending();
	const queryClient = useQueryClient();
	const dismiss = useServerFn(dismissTrainingPromptFn);
	const close = useMutation({
		mutationFn: () => dismiss(),
		onMutate: () =>
			queryClient.setQueryData(PROMPT_KEY(userId), { due: false }),
	});
	const save = useTrainingChoiceSave(userId);
	if (!userId || legalPending || prompt.data?.due !== true) return null;
	return (
		<TrainingConsentCard
			pending={save.isPending}
			error={save.error?.message}
			onContinue={(enabled) => save.mutate(enabled)}
			onDismiss={() => close.mutate()}
		/>
	);
}

export function TrainingConsentCard(props: {
	readonly pending?: boolean;
	readonly error?: string;
	readonly onContinue: (enabled: boolean) => void;
	readonly onDismiss: () => void;
}) {
	const [enabled, setEnabled] = useState(useTrainingChoiceDefault());
	return (
		<section
			role="dialog"
			aria-labelledby="training-prompt-title"
			className="fixed inset-x-4 top-14 z-[250] mx-auto flex max-w-md flex-col sm:inset-x-auto sm:top-auto sm:right-4 sm:bottom-4 sm:mx-0 sm:max-w-sm gap-3 rounded-lg border bg-background p-4 text-sm shadow-lg"
		>
			<div className="flex items-center justify-between gap-2">
				<h2 id="training-prompt-title" className="font-semibold">
					Your privacy choice
				</h2>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					aria-label="Close"
					title="Close without changing anything"
					disabled={props.pending}
					onClick={props.onDismiss}
				>
					<X />
				</Button>
			</div>
			<TrainingChoice
				enabled={enabled}
				onChange={setEnabled}
				disabled={props.pending}
			/>
			{props.error ? (
				<p role="alert" className="text-destructive">
					{props.error}
				</p>
			) : null}
			<div className="flex justify-end">
				<Button
					type="button"
					disabled={props.pending}
					onClick={() => props.onContinue(enabled)}
				>
					{props.pending ? "Saving…" : "Continue"}
				</Button>
			</div>
		</section>
	);
}
