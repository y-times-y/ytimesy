import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowUpRight, Check } from "lucide-react";
import { useState } from "react";
import { type FirstRunState, firstRunStep } from "#/domain/first-run";
import type { RepositoryChoice } from "#/domain/projects";
import type { CodexDeviceLogin } from "#/server/auth/codex-device-login";
import { YtimesyBrand } from "../auth/onboarding-shell";
import { AddProjectForm } from "../projects/add-project-form";
import { requestJson } from "../projects/api";
import { CodexMark } from "../sessions/codex-mark";
import {
	pollCodexLogin,
	startChatgptSignIn,
} from "../sessions/codex-session.fn";
import { ModelConnections } from "../sessions/model-connections";
import { getModelConnections } from "../sessions/model-connections.fn";
import { ModelProviderLogo } from "../sessions/model-provider-logo";
import "./first-run.css";

const STEPS = [
	{ id: "github", label: "GitHub" },
	{ id: "repositories", label: "Repositories" },
	{ id: "model", label: "Model" },
] as const;

const TITLES = {
	github: "Connect GitHub",
	repositories: "Pick your repositories",
	model: "Choose your model",
} as const;

function enterWorkspace() {
	window.location.assign("/");
}

/**
 * A new account's first run, before its first project: GitHub, then the
 * repositories, then a model (skippable). The server says where it stands,
 * so the right step paints first.
 */
export function FirstRun({ state }: { state: FirstRunState }) {
	const [projectAdded, setProjectAdded] = useState(false);
	// Same read as the repository picker: connected once it lists repositories.
	const repositories = useQuery({
		queryKey: ["github", "repositories"],
		queryFn: () =>
			requestJson<{
				repositories: RepositoryChoice[];
				installationUrl: string;
			}>("/api/github/repositories"),
		retry: false,
	});
	const githubConnected = repositories.isPending
		? state.githubConnected
		: Boolean(repositories.data);
	const step = firstRunStep({ githubConnected, projectAdded });
	const at = STEPS.findIndex((item) => item.id === step);
	return (
		<main className="first-run">
			<header className="first-run-top">
				<YtimesyBrand />
			</header>
			<section className="first-run-card" aria-labelledby="first-run-title">
				<ol className="first-run-steps" aria-label="Setup">
					{STEPS.map((item, index) => (
						<li
							key={item.id}
							data-state={
								index < at ? "done" : index === at ? "current" : undefined
							}
						>
							<span className="first-run-dot">
								{index < at ? <Check size={12} strokeWidth={2.6} /> : index + 1}
							</span>
							{item.label}
						</li>
					))}
				</ol>
				<h1 id="first-run-title">{TITLES[step]}</h1>
				{step === "model" ? (
					<ModelStep ready={state.modelReady} />
				) : (
					<AddProjectForm
						variant="page"
						onAdded={(project) => {
							if (state.modelReady) return enterWorkspace();
							// The project's machine builds while the model is chosen;
							// the workspace finds it under way instead of starting it.
							void requestJson("/api/workspaces", {
								projectId: project.id,
							}).catch(() => undefined);
							setProjectAdded(true);
						}}
					/>
				)}
			</section>
		</main>
	);
}

export function ModelStep({ ready: readyAtLoad }: { ready: boolean }) {
	const start = useServerFn(startChatgptSignIn);
	const poll = useServerFn(pollCodexLogin);
	const readConnections = useServerFn(getModelConnections);
	const [login, setLogin] = useState<CodexDeviceLogin | null>(null);
	const [addingKey, setAddingKey] = useState(false);
	const signIn = useMutation({
		mutationFn: () => start({ data: {} }),
		onSuccess: setLogin,
	});
	useQuery({
		queryKey: ["first-run-chatgpt-login"],
		queryFn: async () => {
			const next = await poll({ data: {} });
			setLogin(next);
			return next;
		},
		enabled: login?.status === "pending",
		refetchInterval: 3_000,
		refetchIntervalInBackground: true,
		gcTime: 0,
	});
	const connections = useQuery({
		queryKey: ["model-connections"],
		queryFn: () => readConnections(),
	});
	const chatgptConnected = login?.status === "connected";
	const keySaved = (connections.data?.length ?? 0) > 0;
	const ready = readyAtLoad || chatgptConnected || keySaved;
	return (
		<>
			<div className="first-run-models">
				<div
					className="first-run-model"
					data-done={chatgptConnected || undefined}
				>
					<span className="first-run-logos">
						<CodexMark size={26} />
					</span>
					<strong>Your Codex subscription</strong>
					{chatgptConnected ? (
						<span className="first-run-connected">
							<Check size={14} strokeWidth={2.6} />
							Connected
						</span>
					) : login?.status === "pending" ? (
						<div className="first-run-code">
							<code>{login.userCode}</code>
							<a href={login.verificationUrl} target="_blank" rel="noreferrer">
								Enter it at ChatGPT
								<ArrowUpRight size={13} />
							</a>
						</div>
					) : (
						<button
							type="button"
							className="first-run-secondary"
							disabled={signIn.isPending}
							onClick={() => signIn.mutate()}
						>
							{signIn.isPending ? "Starting…" : "Sign in with ChatGPT"}
						</button>
					)}
					{login?.status === "failed" ? (
						<small role="alert">{login.message}</small>
					) : signIn.error ? (
						<small role="alert">{signIn.error.message}</small>
					) : null}
				</div>
				<div className="first-run-model" data-done={keySaved || undefined}>
					<span className="first-run-logos">
						{["openai", "anthropic", "google", "openrouter"].map((provider) => (
							<ModelProviderLogo key={provider} provider={provider} size={22} />
						))}
					</span>
					<strong>Your API key</strong>
					{keySaved ? (
						<span className="first-run-connected">
							<Check size={14} strokeWidth={2.6} />
							Key saved
						</span>
					) : (
						<button
							type="button"
							className="first-run-secondary"
							aria-expanded={addingKey}
							onClick={() => setAddingKey((open) => !open)}
						>
							Add a key
						</button>
					)}
				</div>
			</div>
			{addingKey ? (
				<div className="first-run-keys">
					<ModelConnections />
				</div>
			) : null}
			<div className="first-run-actions">
				<button
					type="button"
					className="first-run-primary"
					disabled={!ready}
					onClick={enterWorkspace}
				>
					Continue
				</button>
				{ready ? null : (
					<button
						type="button"
						className="first-run-later"
						onClick={enterWorkspace}
					>
						Later
					</button>
				)}
			</div>
		</>
	);
}
