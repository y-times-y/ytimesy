import { Button } from "#/components/ui/button";
import type { ConsentTier } from "./consent-tier";
import type { ReplayBrowserBlock, ReplayChoice } from "./replay-choice";

/**
 * The banner's words and buttons. One short sentence for every rule, as
 * banners usually are; where each rule differs (what waits for Accept) is
 * in the Privacy Policy and in the Cookie settings switch.
 */
export function consentBannerCopy(_tier: ConsentTier) {
	return {
		text: "We use cookies for analytics and masked session replay to improve ytimesy.",
		accept: "Accept",
		reject: "Reject all",
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
			className="fixed inset-x-4 bottom-4 z-[260] mx-auto max-w-md rounded-lg border bg-background p-3 text-xs shadow-lg sm:p-4 sm:text-sm sm:inset-x-auto sm:right-4 sm:mx-0 sm:w-[340px]"
		>
			<p className="text-muted-foreground">
				{copy.text}{" "}
				<a
					href="/privacy#choices"
					className="underline underline-offset-4 hover:text-foreground"
				>
					Cookie settings
				</a>
			</p>
			<div className="mt-2 flex justify-end gap-2 sm:mt-3">
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
