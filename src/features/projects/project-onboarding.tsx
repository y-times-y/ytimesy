import { authClient } from "../auth/client";
import { IdentityGate } from "../auth/identity-gate";
import { OnboardingShell } from "../auth/onboarding-shell";
import { clearChatCache } from "../sessions/chat-cache";
import { AddProjectForm } from "./add-project-form";

export function ProjectOnboarding() {
	return (
		<IdentityGate>
			<OnboardingShell>
				<section className="onboarding-card">
					<a href="/" className="brand">
						<img src="/brand/mark.svg" width="28" height="28" alt="" />
						<span className="brand-name">ytimesy</span>
					</a>
					<h1>Add a project</h1>
					<AddProjectForm
						variant="page"
						onAdded={() => window.location.assign("/")}
					/>
					<a className="setup-back" href="/">
						Back to workspace
					</a>
					<SignOutLink />
				</section>
			</OnboardingShell>
		</IdentityGate>
	);
}

function SignOutLink() {
	const session = authClient.useSession();
	const signedInAs =
		session.data?.user.email ?? session.data?.user.name ?? null;
	return (
		<>
			{signedInAs && <p>Signed in as {signedInAs}</p>}
			<button
				type="button"
				className="setup-back"
				onClick={async () => {
					await clearChatCache();
					await authClient.signOut();
					window.location.assign("/");
				}}
			>
				Sign out
			</button>
		</>
	);
}
