import { useEffect, useState } from "react";
import { useAnalyticsOptInRegion } from "#/features/app/privacy-region";
import { SettingsSwitch } from "#/features/workspace/settings-switch";
import { setReplayChoice } from "./client";
import {
	REPLAY_CHOICE_EVENT,
	type ReplayBrowserBlock,
	type ReplayChoice,
	readReplayChoice,
	replayBrowserBlock,
} from "./replay-choice";

/** Why replay cannot run here, in the visitor's terms; null when it can. */
export function replayUnavailableReason(input: {
	readonly strict: boolean;
	readonly block: ReplayBrowserBlock | null;
}) {
	if (input.strict)
		return "Off where you are: we don't record session replays in your region.";
	if (input.block === "do-not-track")
		return "Off: your browser sends Do Not Track.";
	if (input.block === "global-privacy-control")
		return "Off: your browser sends Global Privacy Control.";
	return null;
}

/** The browser-held choice, read after hydration (the server can't know it). */
function useReplayChoice() {
	const [state, setState] = useState<{
		readonly choice: ReplayChoice | null;
		readonly block: ReplayBrowserBlock | null;
	} | null>(null);
	useEffect(() => {
		const read = () =>
			setState({ choice: readReplayChoice(), block: replayBrowserBlock() });
		read();
		window.addEventListener(REPLAY_CHOICE_EVENT, read);
		window.addEventListener("storage", read);
		return () => {
			window.removeEventListener(REPLAY_CHOICE_EVENT, read);
			window.removeEventListener("storage", read);
		};
	}, []);
	return state;
}

/**
 * Privacy choices: masked session replay on or off for this browser. Shown in
 * Settings → Privacy and on the Privacy Policy page (the footer's "Privacy
 * choices" link), for visitors and signed-in users alike.
 */
export function ReplayChoiceSetting({ id = "replay-choice" }: { id?: string }) {
	const strict = useAnalyticsOptInRegion();
	const state = useReplayChoice();
	const unavailable = state
		? replayUnavailableReason({ strict, block: state.block })
		: null;
	return (
		<div className="settings-row" data-replay-choice="">
			<div className="settings-row-text">
				<label htmlFor={id} className="settings-row-title">
					Session replay
				</label>
				<span className="settings-row-meta">
					{unavailable ??
						"Masked recordings of how the app is used, to find and fix problems. Text, inputs and code are never recorded."}
				</span>
			</div>
			<div className="settings-row-actions">
				{unavailable ? null : (
					<SettingsSwitch
						id={id}
						checked={state ? state.choice !== "declined" : undefined}
						onCheckedChange={(on) =>
							setReplayChoice(on ? "allowed" : "declined")
						}
					/>
				)}
			</div>
		</div>
	);
}

/** Settings → Privacy, below "Help improve ytimesy". */
export function ReplayChoiceSection() {
	return (
		<section className="settings-section">
			<header className="settings-section-head">
				<div>
					<h3>Analytics</h3>
					<p>What this browser sends us to find and fix problems.</p>
				</div>
			</header>
			<div className="settings-group">
				<ReplayChoiceSetting />
			</div>
		</section>
	);
}

/** The Privacy Policy page's "Privacy choices" (the footer links here). */
export function PrivacyChoices() {
	return (
		<section
			id="choices"
			aria-labelledby="choices-title"
			className="mb-10 scroll-mt-6"
		>
			<h2 id="choices-title" className="mb-3 text-base font-semibold">
				Privacy choices
			</h2>
			<div className="settings-group">
				<ReplayChoiceSetting id="replay-choice-page" />
			</div>
		</section>
	);
}
