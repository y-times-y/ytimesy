import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { needsGithubSetup } from "#/domain/github-sign-in";
import { authClient } from "../auth/client";
import { GithubOptions } from "../onboarding/setup-options";
import { getSetupState } from "../onboarding/setup-state.fn";
import { requestJson } from "./api";

/**
 * A failed project setup whose cause is a missing GitHub link: the message
 * and the same Connect step the composer shows, in place. Other failures
 * render nothing here.
 */
export function GithubSetupStep({ message }: { message: string }) {
	const wanted = needsGithubSetup(message);
	const userId = authClient.useSession().data?.user.id;
	const readState = useServerFn(getSetupState);
	const state = useQuery({
		queryKey: ["setup-state", userId],
		queryFn: () => readState(),
		enabled: wanted && Boolean(userId),
	});
	const repositories = useQuery({
		queryKey: ["github", "repositories"],
		queryFn: () =>
			requestJson<{ installationUrl: string }>("/api/github/repositories"),
		retry: false,
		enabled: wanted && Boolean(userId),
	});
	if (!wanted) return null;
	return (
		<section
			aria-label="Connect GitHub"
			className="flex w-full flex-col gap-2 text-xs"
		>
			<p>{message}</p>
			<GithubOptions
				signedIn={Boolean(state.data?.githubConnected)}
				checking={state.isPending}
				installationUrl={repositories.data?.installationUrl}
			/>
		</section>
	);
}
