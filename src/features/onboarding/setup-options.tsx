import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowUpRight, Check } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import type { RepositoryChoice } from "#/domain/projects";
import { cn } from "#/lib/utils";
import { ContinueSessionCard } from "../local-import/continue-session-card";
import { requestJson } from "../projects/api";
import { useGithubConnectionNotice } from "../projects/github-connection-notice";
import { ChatgptSignIn } from "../sessions/chatgpt-sign-in";
import { ClaudeSetupTokenSignIn } from "../sessions/claude-setup-token-sign-in";
import { ModelConnections } from "../sessions/model-connections";
import { getModelConnections } from "../sessions/model-connections.fn";
import { ModelProviderLogo } from "../sessions/model-provider-logo";
import { SubscriptionMark } from "../sessions/subscription-mark";
import { XaiSubscriptionSignIn } from "../sessions/xai-subscription-sign-in";
import { GithubMark } from "../workspace/github-mark";

/** One thing to do inside a step: a mark, a name, a line, and its control. */
function Option({
	mark,
	title,
	line,
	done,
	children,
}: {
	mark: React.ReactNode;
	title: string;
	line: string;
	done?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div
			data-done={done || undefined}
			className={cn(
				"flex min-w-0 flex-col gap-2.5 rounded-lg bg-background/40 p-3 ring-1 ring-foreground/10 transition-colors",
				done && "ring-foreground/30",
			)}
		>
			<div className="flex items-center gap-2">
				<span className="flex h-5 shrink-0 items-center gap-1">{mark}</span>
				<span className="truncate text-xs font-medium">{title}</span>
				{done ? (
					<Check
						size={13}
						strokeWidth={2.6}
						className="ml-auto text-foreground"
						aria-label="Connected"
					/>
				) : null}
			</div>
			<p className="text-[0.6875rem] leading-snug text-muted-foreground">
				{line}
			</p>
			<div className="mt-auto [&_.chatgpt-sign-in-button]:h-7! [&_.chatgpt-sign-in-button]:rounded-md! [&_.chatgpt-sign-in-button]:px-2.5! [&_.chatgpt-sign-in-button]:text-xs! [&_.chatgpt-sign-in-button]:font-medium!">
				{children}
			</div>
		</div>
	);
}

/**
 * Choose where chats run: a ChatGPT, Claude or Grok subscription, or an API
 * key. Claude and Grok show while their launch switches are on.
 */
export function ModelOptions({
	ready: readyAtLoad,
	xaiSubscription = false,
	claudeSubscription = false,
	onDone,
}: {
	ready: boolean;
	xaiSubscription?: boolean;
	claudeSubscription?: boolean;
	/** Continue, or Later: the next thing to do. */
	onDone: () => void;
}) {
	const readConnections = useServerFn(getModelConnections);
	const [chatgpt, setChatgpt] = useState(false);
	const [claude, setClaude] = useState(false);
	const [grok, setGrok] = useState(false);
	const [addingKey, setAddingKey] = useState(false);
	const connections = useQuery({
		queryKey: ["model-connections"],
		queryFn: () => readConnections(),
	});
	const keySaved = (connections.data ?? []).some((row) => !row.subscription);
	const ready = readyAtLoad || chatgpt || claude || grok || keySaved;
	return (
		<div className="flex flex-col gap-3">
			<div className="grid gap-2 sm:grid-cols-2">
				<Option
					mark={<SubscriptionMark brand="codex" size={20} />}
					title="ChatGPT subscription"
					line="Your Codex plan, on our harness."
					done={chatgpt}
				>
					<ChatgptSignIn onConnected={() => setChatgpt(true)} />
				</Option>
				{claudeSubscription ? (
					<Option
						mark={<SubscriptionMark brand="claude" size={20} />}
						title="Claude subscription"
						line="Pro or Max, through the Claude Agent SDK."
						done={claude}
					>
						<ClaudeSetupTokenSignIn onConnected={() => setClaude(true)} />
					</Option>
				) : null}
				{xaiSubscription ? (
					<Option
						mark={<SubscriptionMark brand="grok" size={20} />}
						title="Grok subscription"
						line="SuperGrok or X subscription, on our harness."
						done={grok}
					>
						<XaiSubscriptionSignIn onConnected={() => setGrok(true)} />
					</Option>
				) : null}
				<Option
					mark={["openai", "anthropic", "google", "openrouter"].map(
						(provider) => (
							<ModelProviderLogo key={provider} provider={provider} size={15} />
						),
					)}
					title="API key"
					line="Your OpenAI, Anthropic, Google or xAI key, or one OpenRouter key."
					done={keySaved}
				>
					{keySaved ? (
						<span className="text-xs text-muted-foreground">Key saved</span>
					) : (
						<Button
							type="button"
							size="sm"
							variant="outline"
							aria-expanded={addingKey}
							onClick={() => setAddingKey((open) => !open)}
						>
							Add a key
						</Button>
					)}
				</Option>
			</div>
			{addingKey ? <ModelConnections startAdding /> : null}
			<div className="flex items-center gap-2">
				<Button type="button" size="sm" disabled={!ready} onClick={onDone}>
					Continue
				</Button>
				{ready ? null : (
					<Button type="button" size="sm" variant="ghost" onClick={onDone}>
						Later
					</Button>
				)}
				<p className="ml-auto text-[0.6875rem] text-muted-foreground">
					Nothing falls back to paid inference.
				</p>
			</div>
		</div>
	);
}

/**
 * Sign in with GitHub (OAuth through the app), then install the app on the
 * repositories ytimesy may work in. Signing in alone reaches none.
 */
export function GithubOptions({
	signedIn,
	checking,
	installationUrl,
}: {
	signedIn: boolean;
	/** Signed in; the app's repositories are still loading. */
	checking: boolean;
	installationUrl: string | undefined;
}) {
	const [notice] = useGithubConnectionNotice();
	const connect = useMutation({
		mutationFn: () => requestJson<{ url: string }>("/api/github/connect", {}),
		onSuccess: ({ url }) => window.location.assign(url),
	});
	const [installOpened, setInstallOpened] = useState(false);
	return (
		<div className="flex flex-col gap-2">
			{notice ? <p role="alert">{notice}</p> : null}
			{connect.error ? <p role="alert">{connect.error.message}</p> : null}
			<Option
				mark={<GithubMark size={16} />}
				title="Sign in with GitHub"
				line="Links your GitHub account."
				done={signedIn}
			>
				{signedIn ? (
					<span className="text-xs text-muted-foreground">Connected</span>
				) : (
					<Button
						type="button"
						size="sm"
						disabled={connect.isPending}
						onClick={() => connect.mutate()}
					>
						{connect.isPending ? "Opening GitHub…" : "Connect"}
					</Button>
				)}
			</Option>
			<Option
				mark={<img src="/brand/mark.svg" width={16} height={16} alt="" />}
				title="Install the ytimesy app"
				line={
					installOpened
						? "Finish on GitHub. This card updates on its own."
						: "Give it access to the repositories it may work in."
				}
			>
				{signedIn && installationUrl ? (
					<Button asChild size="sm" variant="outline">
						<a
							href={installationUrl}
							target="_blank"
							rel="noreferrer"
							onClick={() => setInstallOpened(true)}
						>
							Install
							<ArrowUpRight size={13} />
						</a>
					</Button>
				) : (
					<span className="text-xs text-muted-foreground">
						{checking ? "Checking…" : "After sign-in"}
					</span>
				)}
			</Option>
		</div>
	);
}

/** Optional: the same import card as Settings > Import; skipping never waits on it. */
export function SessionsOptions({ onSkip }: { onSkip: () => void }) {
	return (
		<div className="flex flex-col gap-3">
			<ContinueSessionCard githubConnected heading={false} />
			<div>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					onClick={onSkip}
					title="Skip or finish later: import any time from Settings > Import."
				>
					Skip for now
				</Button>
			</div>
		</div>
	);
}

export type { RepositoryChoice };
