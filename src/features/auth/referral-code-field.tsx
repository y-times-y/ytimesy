import { useEffect, useState } from "react";
import { referralCodeFromInput } from "#/domain/referral";
import {
	savedReferralCode,
	saveReferralCode,
} from "#/features/analytics/first-touch";

/**
 * Under the sign-in and sign-up buttons: a way to enter a referral code by hand,
 * for a link that lost its code on the way (copied without it, opened in
 * another app). Paste the code or the whole link. It is kept like a code from a
 * link, so it also survives the GitHub and Google round trips and the email
 * code step. The line is the same height whatever it says, so nothing moves
 * when the page hydrates.
 */
export function ReferralCodeField() {
	const [applied, setApplied] = useState(false);
	const [open, setOpen] = useState(false);
	const [problem, setProblem] = useState(false);
	useEffect(() => setApplied(savedReferralCode() !== null), []);
	const apply = (text: string) => {
		const code = referralCodeFromInput(text);
		setProblem(!code && text.trim() !== "");
		if (!code) return;
		saveReferralCode(code);
		setApplied(true);
		setOpen(false);
	};
	return (
		<div className="text-center text-xs text-muted-foreground">
			{open ? (
				<form
					className="flex items-center justify-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						apply(String(new FormData(event.currentTarget).get("code") ?? ""));
					}}
				>
					<input
						name="code"
						// biome-ignore lint/a11y/noAutofocus: the person just asked for this field
						autoFocus
						aria-label="Referral code or link"
						aria-invalid={problem}
						placeholder="r-xxxxxxxx or the link"
						className="h-8 w-48 rounded-md border bg-transparent px-2 text-xs"
					/>
					<button type="submit" className="underline underline-offset-4">
						Apply
					</button>
				</form>
			) : (
				<button
					type="button"
					className="underline underline-offset-4"
					onClick={() => setOpen(true)}
				>
					{applied ? "Referral code applied" : "Have a referral code?"}
				</button>
			)}
			{problem ? (
				<span role="alert" className="block">
					That is not a referral code.
				</span>
			) : null}
		</div>
	);
}
