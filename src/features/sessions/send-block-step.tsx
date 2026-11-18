import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check } from "lucide-react";
import type { ComposerSendBlock } from "#/domain/send-blocked";
import { authClient } from "../auth/client";
import { GithubOptions, ModelOptions } from "../onboarding/setup-options";
import { getSetupState } from "../onboarding/setup-state.fn";
import { requestJson } from "../projects/api";
import { SendBlockNotice } from "./send-block-notice";

/**
 * Under the composer when a send cannot go. For a missing model or GitHub the
 * step to fix it opens right here, with the message kept in the box, instead
 * of a line pointing at Settings. Other reasons keep the plain notice.
 */
export function SendBlockStep({
	block,
	onFix,
}: {
	block: ComposerSendBlock;
	onFix?: (block: ComposerSendBlock) => void;
}) {
	if (block.kind !== "no_model" && block.kind !== "github")
		return <SendBlockNotice block={block} onFix={onFix} />;
	return <MissingStep kind={block.kind} />;
}

function MissingStep({ kind }: { kind: "no_model" | "github" }) {
	const session = authClient.useSession();
	const userId = session.data?.user.id;
	const readState = useServerFn(getSetupState);
	const state = useQuery({
		queryKey: ["setup-state", userId],
		queryFn: () => readState(),
		enabled: Boolean(userId),
	});
	const repositories = useQuery({
		queryKey: ["github", "repositories"],
		queryFn: () =>
			requestJson<{ installationUrl: string }>("/api/github/repositories"),
		retry: false,
		enabled: kind === "github" && Boolean(userId),
	});
	return (
		<section
			aria-label={kind === "github" ? "Connect GitHub" : "Choose a model"}
			className="mx-auto mb-3 flex w-full flex-col gap-3 rounded-xl bg-card p-4 text-xs text-card-foreground ring-1 ring-foreground/10"
		>
			<div>
				<h2 className="text-[0.8125rem] font-semibold">
					{kind === "github"
						? "Connect GitHub to send"
						: "Choose a model to send"}
				</h2>
				<p className="mt-1 flex items-center gap-1.5 text-muted-foreground">
					<Check size={12} aria-hidden="true" />
					Your message is saved. It stays in the box.
				</p>
			</div>
			{kind === "github" ? (
				<GithubOptions
					signedIn={Boolean(state.data?.githubConnected)}
					checking={state.isPending}
					installationUrl={repositories.data?.installationUrl}
				/>
			) : (
				<ModelOptions
					ready={Boolean(state.data?.modelReady)}
					xaiSubscription={state.data?.xaiSubscription}
					claudeSubscription={state.data?.claudeSubscription}
					// A full load, so the page starts with the model ready.
					onDone={() => window.location.reload()}
				/>
			)}
		</section>
	);
}
