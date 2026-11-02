import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { X } from "lucide-react";
import { Button } from "#/components/ui/button";
import { CURRENT_LEGAL_VERSIONS } from "#/domain/legal-acceptance";
import { authClient } from "./client";
import {
	acceptLegalTermsFn,
	getLegalAcceptanceFn,
} from "./legal-acceptance.fn";

/**
 * Sign-in records acceptance of the current Terms and Privacy Policy (see
 * signedIn in src/server/auth/auth.ts). A session that started before the
 * documents changed gets a small notice instead; dismissing it records
 * acceptance. Nothing blocks the app.
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
 * Whether the Terms notice is (or may be about to be) on screen, so other
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
		// A failed read never shows the Terms notice, so it holds nothing back.
		current: status.isError ? true : status.data?.current,
	});
}

export function LegalUpdateNotice() {
	const { userId, status } = useLegalAcceptance();
	const queryClient = useQueryClient();
	const accept = useServerFn(acceptLegalTermsFn);
	const save = useMutation({
		mutationFn: () => accept({ data: CURRENT_LEGAL_VERSIONS }),
		// Hidden at once; a failed write shows the notice again on the next load.
		onMutate: () =>
			queryClient.setQueryData(["legal-acceptance", userId], {
				current: true,
				updated: true,
			}),
	});
	if (!userId || !status.data || status.data.current) return null;
	return <LegalUpdateCard onDismiss={() => save.mutate()} />;
}

export function LegalUpdateCard(props: { readonly onDismiss: () => void }) {
	return (
		<section
			aria-label="Terms update"
			className="fixed inset-x-4 top-14 z-[250] mx-auto flex max-w-md items-center gap-3 rounded-lg border bg-background py-2 pr-2 pl-4 text-sm shadow-lg"
		>
			<p className="flex-1 text-muted-foreground">
				We updated our{" "}
				<a
					href="/terms"
					target="_blank"
					rel="noopener noreferrer"
					className="underline underline-offset-4"
				>
					Terms
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
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label="Dismiss"
				title="Continuing means you agree to them"
				onClick={props.onDismiss}
			>
				<X />
			</Button>
		</section>
	);
}
