import { needsGithubSetup } from "../../domain/github-sign-in";

export function GithubSetupLink({ message }: { message: string }) {
	if (!needsGithubSetup(message)) return null;
	return <a href="/onboarding">Open GitHub setup</a>;
}
