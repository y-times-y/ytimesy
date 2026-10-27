import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { CURRENT_LEGAL_VERSIONS } from "#/domain/legal-acceptance";
import { clearChatCache } from "../sessions/chat-cache";
import { authClient } from "./client";
import {
	acceptLegalTermsFn,
	getLegalAcceptanceFn,
} from "./legal-acceptance.fn";

/**
 * Asks a signed-in user to accept the current Terms and Privacy Policy when
 * they have no recorded acceptance or accepted an older version. The rest of
 * the app stays behind the dialog until they accept or sign out.
 */
function useLegalAcceptance() {
	const session = authClient.useSession();
	const userId = session.data?.user.id;
	const read = useServerFn(getLegalAcceptanceFn);
	const status = useQuery({
		queryKey: ["legal-acceptance", userId],
		queryFn: () => read(),
		enabled: Boolean(userId),
		staleTime: Number.POSITIVE_INFINITY,
	});
	return { session, userId, status };
}

/**
 * Whether the Terms prompt is (or may be about to be) on screen, so other
 * prompts wait their turn: one prompt at a time.
 */
export function legalPromptPending(input: {
	readonly sessionPending: boolean;
	readonly userId: string | undefined;
	readonly statusPending: boolean;
	readonly current: boolean | undefined;
}): boolean {
	if (input.sessionPending) return true;
	if (!input.userId) return false;
	if (input.statusPending) return true;
	return input.current !== true;
}

export function useLegalPromptPending(): boolean {
	const { session, userId, status } = useLegalAcceptance();
	return legalPromptPending({
		sessionPending: session.isPending,
		userId,
		statusPending: status.isPending,
		// A failed read never shows the Terms prompt, so it holds nothing back.
		current: status.isError ? true : status.data?.current,
	});
}

export function LegalAcceptancePrompt() {
	const { userId, status } = useLegalAcceptance();
	const queryClient = useQueryClient();
	const accept = useServerFn(acceptLegalTermsFn);
	const save = useMutation({
		mutationFn: () => accept({ data: CURRENT_LEGAL_VERSIONS }),
		onSuccess: () =>
			queryClient.setQueryData(["legal-acceptance", userId], {
				current: true,
				updated: true,
			}),
	});
	if (!userId || !status.data || status.data.current) return null;
	return (
		<LegalAcceptanceDialog
			updated={status.data.updated}
			pending={save.isPending}
			error={save.error?.message}
			onAccept={() => save.mutate()}
			onSignOut={async () => {
				await clearChatCache();
				await authClient.signOut().catch(() => undefined);
				window.location.assign("/");
			}}
		/>
	);
}

export function LegalAcceptanceDialog(props: {
	readonly updated: boolean;
	readonly pending?: boolean;
	readonly error?: string;
	readonly onAccept: () => void;
	readonly onSignOut: () => void;
}) {
	const [agreed, setAgreed] = useState(false);
	return (
		<div className="fixed inset-0 z-[300] grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
			<section
				role="dialog"
				aria-modal="true"
				aria-labelledby="legal-acceptance-title"
				className="w-full max-w-md space-y-4 rounded-lg border bg-background p-6 text-sm shadow-lg"
			>
				<h2 id="legal-acceptance-title" className="text-base font-semibold">
					{props.updated
						? "We updated our Terms and Privacy Policy"
						: "Review our Terms and Privacy Policy"}
				</h2>
				<p className="text-muted-foreground">
					To keep using ytimesy, please read and accept the{" "}
					<a
						href="/terms"
						target="_blank"
						rel="noopener noreferrer"
						className="underline underline-offset-4"
					>
						Terms of Service
					</a>{" "}
					and{" "}
					<a
						href="/privacy"
						target="_blank"
						rel="noopener noreferrer"
						className="underline underline-offset-4"
					>
						Privacy Policy
					</a>
					.
				</p>
				<div className="flex items-start gap-2 text-muted-foreground">
					<Checkbox
						id="legal-acceptance-consent"
						checked={agreed}
						onCheckedChange={(value) => setAgreed(value === true)}
						disabled={props.pending}
						aria-required
						className="mt-0.5"
					/>
					<label htmlFor="legal-acceptance-consent">
						I agree to the Terms and Privacy Policy.
					</label>
				</div>
				{props.error ? (
					<p role="alert" className="text-destructive">
						{props.error}
					</p>
				) : null}
				<div className="flex justify-end gap-2">
					<Button
						type="button"
						variant="ghost"
						disabled={props.pending}
						onClick={props.onSignOut}
					>
						Sign out
					</Button>
					<Button
						type="button"
						disabled={!agreed || props.pending}
						onClick={props.onAccept}
					>
						{props.pending ? "Saving…" : "Accept and continue"}
					</Button>
				</div>
			</section>
		</div>
	);
}
