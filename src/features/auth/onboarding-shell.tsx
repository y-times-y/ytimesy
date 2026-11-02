import type { ReactNode } from "react";
import { Wordmark } from "#/components/brand/wordmark";

export function YtimesyBrand() {
	return (
		<a href="/" className="brand" aria-label="Y times Y home">
			<Wordmark />
		</a>
	);
}

export function OnboardingShell({ children }: { children: ReactNode }) {
	return <main className="onboarding-shell">{children}</main>;
}
