import type { ReactNode } from "react";

export function YtimesyBrand() {
	return (
		<a href="/" className="brand" aria-label="ytimesy home">
			<img src="/brand/mark.svg" width={28} height={28} alt="" />
			<span className="brand-name">ytimesy</span>
		</a>
	);
}

export function OnboardingShell({ children }: { children: ReactNode }) {
	return <main className="onboarding-shell">{children}</main>;
}
