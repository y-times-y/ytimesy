import { useState } from "react";
import { authClient } from "./client";

export function IdentityGate({ children }: { children: React.ReactNode }) {
	const session = authClient.useSession();
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	if (session.isPending)
		return (
			<main className="onboarding-shell">
				<p role="status">Loading…</p>
			</main>
		);
	if (session.data) return children;
	return (
		<main className="onboarding-shell">
			<section className="onboarding-card">
				<a href="/" className="brand">
					<img src="/brand/mark.svg" width="32" height="32" alt="" />
					<span className="brand-name">ytimesy</span>
				</a>
				<h1>Sign in</h1>
				<p>Continue with your GitHub account.</p>
				<button
					className="setup-primary"
					type="button"
					disabled={pending}
					onClick={async () => {
						setPending(true);
						setError("");
						try {
							const result = await authClient.signIn.social({
								provider: "github",
								callbackURL: "/onboarding",
								errorCallbackURL: "/onboarding",
							});
							if (result.error) throw new Error(result.error.message);
						} catch {
							setError("Sign-in could not start. Please try again.");
							setPending(false);
						}
					}}
				>
					{pending ? "Opening GitHub…" : "Continue with GitHub"}
				</button>
				{(error || session.error) && (
					<p role="alert">
						{error || "Unable to check your session. Please refresh."}
					</p>
				)}
			</section>
		</main>
	);
}
