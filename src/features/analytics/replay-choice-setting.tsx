import { useConsentTier } from "#/features/app/privacy-region";
import { SettingsSwitch } from "#/features/workspace/settings-switch";
import { setReplayChoice } from "./client";
import type { ConsentTier } from "./consent-tier";
import type { ReplayBrowserBlock, ReplayChoice } from "./replay-choice";
import { useReplayChoice } from "./use-replay-choice";

/** Why analytics cannot run here, in the visitor's terms; null when it can. */
export function replayUnavailableReason(input: {
	readonly block: ReplayBrowserBlock | null;
}) {
	if (input.block === "do-not-track")
		return "Off: your browser sends Do Not Track.";
	if (input.block === "global-privacy-control")
		return "Off: your browser sends Global Privacy Control.";
	return null;
}

/** What the switch controls and its words, by consent rule. */
export function replaySettingCopy(tier: ConsentTier) {
	if (tier === "analytics")
		return {
			title: "Analytics and session replay",
			meta: "Off until you allow it. Analytics counts visits and errors; masked recordings show how the app is used. Text, inputs and code are never recorded.",
		};
	return {
		title: "Session replay",
		meta: "Masked recordings of how the app is used, to find and fix problems. Text, inputs and code are never recorded.",
	};
}

/** Whether the switch reads on: an Accept where consent comes first, else not turned off. */
export function replaySwitchOn(tier: ConsentTier, choice: ReplayChoice | null) {
	return tier === "notice" ? choice !== "declined" : choice === "allowed";
}

/**
 * Cookie settings: analytics and masked session replay on or off for this
 * browser. Shown in Settings → Privacy and on the Privacy Policy page (the
 * footer's "Cookie settings" link), for visitors and signed-in users alike.
 */
export function ReplayChoiceSetting({ id = "replay-choice" }: { id?: string }) {
	const tier = useConsentTier();
	const state = useReplayChoice();
	const unavailable = state
		? replayUnavailableReason({ block: state.block })
		: null;
	const copy = replaySettingCopy(tier);
	return (
		<div className="settings-row" data-replay-choice="">
			<div className="settings-row-text">
				<label htmlFor={id} className="settings-row-title">
					{copy.title}
				</label>
				<span className="settings-row-meta">{unavailable ?? copy.meta}</span>
			</div>
			<div className="settings-row-actions">
				{unavailable ? null : (
					<SettingsSwitch
						id={id}
						checked={state ? replaySwitchOn(tier, state.choice) : undefined}
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

/** The Privacy Policy page's "Cookie settings" (the footer links here). */
export function PrivacyChoices() {
	return (
		<section
			id="choices"
			aria-labelledby="choices-title"
			className="mb-10 scroll-mt-6"
		>
			<h2 id="choices-title" className="mb-3 text-base font-semibold">
				Cookie settings
			</h2>
			<div className="settings-group">
				<ReplayChoiceSetting id="replay-choice-page" />
			</div>
		</section>
	);
}
