import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowUpRight, Check } from "lucide-react";
import { useState } from "react";
import type { XaiDeviceLogin } from "#/server/auth/xai-device-login";
import { startAddXaiAccountFn } from "./subscription-accounts.fn";
import { pollXaiSignIn, startXaiSignIn } from "./xai-subscription.fn";

/**
 * Sign in with xAI in place, as ChatGPT's sign-in works: the button starts a
 * device sign-in, the code shows with a link to approve it, and it polls
 * until xAI approves.
 */
export function XaiSubscriptionSignIn({
	label = "Sign in with xAI",
	onConnected,
	addAs,
}: {
	label?: string;
	onConnected?: () => void;
	/** A name: sign in another xAI account next to the one already connected. */
	addAs?: string;
}) {
	const start = useServerFn(startXaiSignIn);
	const startAnother = useServerFn(startAddXaiAccountFn);
	const poll = useServerFn(pollXaiSignIn);
	const [login, setLogin] = useState<XaiDeviceLogin | null>(null);
	const signIn = useMutation({
		mutationFn: () =>
			addAs ? startAnother({ data: { label: addAs } }) : start({ data: {} }),
		onSuccess: setLogin,
	});
	useQuery({
		queryKey: ["xai-sign-in"],
		queryFn: async () => {
			const next = await poll({ data: {} });
			setLogin(next);
			if (next.status === "connected") onConnected?.();
			return next;
		},
		enabled: login?.status === "pending",
		refetchInterval: 3_000,
		refetchIntervalInBackground: true,
		gcTime: 0,
	});
	if (login?.status === "connected")
		return (
			<span className="chatgpt-sign-in-done">
				<Check size={14} strokeWidth={2.6} />
				Connected
			</span>
		);
	return (
		<div className="chatgpt-sign-in">
			{login?.status === "pending" ? (
				<span className="chatgpt-sign-in-code">
					<code>{login.userCode}</code>
					<a
						href={login.verificationUrl}
						target="_blank"
						rel="noreferrer"
						title="Approve the code with the xAI account that has SuperGrok or an X subscription. This page updates on its own."
					>
						Approve at xAI
						<ArrowUpRight size={13} />
					</a>
				</span>
			) : (
				<button
					type="button"
					className="chatgpt-sign-in-button"
					disabled={signIn.isPending}
					title="Uses your SuperGrok or X subscription for Grok models. Usage counts against your plan, not an API bill."
					onClick={() => signIn.mutate()}
				>
					{signIn.isPending ? "Starting…" : label}
				</button>
			)}
			{login?.status === "failed" ? (
				<small role="alert">{login.message}</small>
			) : signIn.error ? (
				<small role="alert">{signIn.error.message}</small>
			) : null}
		</div>
	);
}
