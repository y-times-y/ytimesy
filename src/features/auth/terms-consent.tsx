import { Link } from "@tanstack/react-router";
import { Checkbox } from "#/components/ui/checkbox";

/** Required before an account is created from the sign-up page. */
export function TermsConsent({
	checked,
	onCheckedChange,
	disabled,
}: {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled?: boolean;
}) {
	return (
		<div className="flex items-start gap-2 text-sm text-muted-foreground">
			<Checkbox
				id="terms-consent"
				checked={checked}
				onCheckedChange={(value) => onCheckedChange(value === true)}
				disabled={disabled}
				required
				aria-required
				className="mt-0.5"
			/>
			<label htmlFor="terms-consent">
				I agree to the{" "}
				<Link to="/terms" className="underline underline-offset-4">
					Terms
				</Link>{" "}
				and{" "}
				<Link to="/privacy" className="underline underline-offset-4">
					Privacy Policy
				</Link>
				.
			</label>
		</div>
	);
}

/** Sign-in can create an account through GitHub or Google; say what applies. */
export function TermsNotice() {
	return (
		<p className="text-center text-xs text-muted-foreground">
			By continuing, you agree to the{" "}
			<Link to="/terms" className="underline underline-offset-4">
				Terms
			</Link>{" "}
			and{" "}
			<Link to="/privacy" className="underline underline-offset-4">
				Privacy Policy
			</Link>
			.
		</p>
	);
}
