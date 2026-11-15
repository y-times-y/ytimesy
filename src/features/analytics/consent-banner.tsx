import { Button } from "#/components/ui/button";
import type { ConsentTier } from "./consent-tier";
import type { ReplayBrowserBlock, ReplayChoice } from "./replay-choice";

/** The banner's words and buttons for each consent rule. */
export function consentBannerCopy(tier: ConsentTier) {
	if (tier === "analytics")
		return {
			text: "May we use analytics and record masked session replays to find and fix problems? Nothing is recorded, sent or stored unless you accept.",
			accept: "Accept",
			reject: "Decline",
		};
	if (tier === "replay")
		return {
			text: "We count visits and errors. May we also record masked session replays to find and fix problems?",
			accept: "Accept",
			reject: "Decline",
		};
	return {
		text: "We record masked session replays to find and fix problems. Text and anything you type are never recorded.",
		accept: "OK",
		reject: "Turn off",
	};
}

/**
 * Whether the first-visit banner shows: nobody has chosen yet, the browser
 * sends no privacy signal (then nothing here could record anyway), and a
 * signed-in user is not told about the default-on notice (they accept the
 * Privacy Policy when they sign in).
 */
export function consentBannerVisible(input: {
	readonly tier: ConsentTier;
	readonly choice: ReplayChoice | null;
	readonly block: ReplayBrowserBlock | null;
	readonly signedIn: boolean;
}) {
	if (input.choice !== null || input.block !== null) return false;
	return !(input.tier === "notice" && input.signedIn);
}

export function ConsentBanner(props: {
	readonly tier: ConsentTier;
	readonly onChoose: (choice: ReplayChoice) => void;
}) {
	const copy = consentBannerCopy(props.tier);
	return (
		<section
			aria-label="Cookie settings"
			data-consent-banner={props.tier}
			className="fixed inset-x-4 bottom-4 z-[260] mx-auto max-w-md rounded-lg border bg-background p-4 text-sm shadow-lg sm:inset-x-auto sm:right-4 sm:mx-0 sm:w-[340px]"
		>
			<p className="text-muted-foreground">
				{copy.text}{" "}
				<a
					href="/privacy#choices"
					className="underline underline-offset-4 hover:text-foreground"
				>
					Privacy Policy
				</a>
			</p>
			<div className="mt-3 flex justify-end gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => props.onChoose("declined")}
				>
					{copy.reject}
				</Button>
				<Button
					type="button"
					size="sm"
					onClick={() => props.onChoose("allowed")}
				>
					{copy.accept}
				</Button>
			</div>
		</section>
	);
}
