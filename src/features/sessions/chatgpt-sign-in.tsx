import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowUpRight, Check } from "lucide-react";
import { useState } from "react";
import type { CodexDeviceLogin } from "#/server/auth/codex-device-login";
import { pollCodexLogin, startChatgptSignIn } from "./codex-session.fn";

/**
 * Sign in with ChatGPT in place: the button starts a device sign-in, the code
 * shows with a link to enter it, and it polls until approved.
 */
export function ChatgptSignIn({
	label = "Sign in with ChatGPT",
	onConnected,
	showHint = true,
}: {
	label?: string;
	onConnected?: () => void;
	/** False where the caller shows DeviceCodeHint itself (a settings row's text column). */
	showHint?: boolean;
}) {
	const start = useServerFn(startChatgptSignIn);
	const poll = useServerFn(pollCodexLogin);
	const [login, setLogin] = useState<CodexDeviceLogin | null>(null);
	const signIn = useMutation({
		mutationFn: () => start({ data: {} }),
		onSuccess: setLogin,
	});
	useQuery({
		queryKey: ["chatgpt-sign-in"],
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
					<a href={login.verificationUrl} target="_blank" rel="noreferrer">
						Enter it at ChatGPT
						<ArrowUpRight size={13} />
					</a>
				</span>
			) : (
				<button
					type="button"
					className="chatgpt-sign-in-button"
					disabled={signIn.isPending}
					onClick={() => signIn.mutate()}
				>
					{signIn.isPending ? "Starting…" : label}
				</button>
			)}
			{showHint ? <DeviceCodeHint /> : null}
			{login?.status === "failed" ? (
				<small role="alert">{login.message}</small>
			) : signIn.error ? (
				<small role="alert">{signIn.error.message}</small>
			) : null}
		</div>
	);
}

/**
 * ChatGPT refuses the code until device code sign-in is on for the account
 * (Settings > Security). On a workspace, an admin turns it on instead.
 */
export function DeviceCodeHint() {
	return (
		<p
			className="chatgpt-sign-in-hint"
			title="On a ChatGPT Business or Enterprise workspace, an admin turns this on in the workspace permissions."
		>
			<strong>Turn on device code sign-in</strong> in{" "}
			<a
				href="https://chatgpt.com/#settings/Security"
				target="_blank"
				rel="noreferrer"
			>
				ChatGPT Settings → Security
			</a>
			, if you haven't already.
		</p>
	);
}
