import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { useLegalPromptPending } from "../auth/legal-acceptance-prompt";
import { useTrainingPromptPending } from "../workspace/training-consent-prompt";
import { loadAnalytics } from "./client";
import {
	onReplayConsentChange,
	type ReplayConsent,
	readReplayConsent,
	saveReplayConsent,
} from "./replay-consent";

/** Replay can only run where analytics is configured and Do Not Track is off. */
function replayPossible() {
	return (
		Boolean(import.meta.env.VITE_POSTHOG_PROJECT_TOKEN) &&
		typeof navigator !== "undefined" &&
		navigator.doNotTrack !== "1"
	);
}

/** The visitor's replay choice; undefined until read in the browser. */
export function useReplayConsent() {
	const [choice, setChoice] = useState<ReplayConsent | null | undefined>();
	useEffect(() => {
		setChoice(readReplayConsent());
		return onReplayConsentChange(setChoice);
	}, []);
	return choice;
}

export function chooseReplay(choice: ReplayConsent) {
	saveReplayConsent(choice);
	if (choice === "accepted") loadAnalytics();
}

/**
 * Asked once per browser; nothing is recorded until "Accept". Waits for the
 * Terms notice and the training card, so only one prompt shows at a time.
 */
export function ReplayConsentBanner() {
	const choice = useReplayConsent();
	const termsPending = useLegalPromptPending();
	const trainingPending = useTrainingPromptPending();
	if (choice !== null || !replayPossible() || termsPending || trainingPending)
		return null;
	return <ReplayConsentPrompt onChoose={chooseReplay} />;
}

export function ReplayConsentPrompt(props: {
	readonly onChoose: (choice: ReplayConsent) => void;
}) {
	return (
		<section
			aria-label="Session recording"
			className="fixed inset-x-4 bottom-4 z-[250] mx-auto flex max-w-xl flex-col gap-3 rounded-lg border bg-background p-4 text-sm shadow-lg sm:flex-row sm:items-center"
		>
			<p className="flex-1 text-muted-foreground">
				May we record how you use ytimesy to improve it? Recordings hide all
				text, code, chats and inputs. See the{" "}
				<a href="/privacy" className="underline underline-offset-4">
					Privacy Policy
				</a>
				.
			</p>
			<div className="flex shrink-0 gap-2">
				<Button
					type="button"
					variant="outline"
					onClick={() => props.onChoose("declined")}
				>
					Decline
				</Button>
				<Button type="button" onClick={() => props.onChoose("accepted")}>
					Accept
				</Button>
			</div>
		</section>
	);
}
