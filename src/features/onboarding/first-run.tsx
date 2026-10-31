import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowUpRight, Check } from "lucide-react";
import { useState } from "react";
import {
	FIRST_RUN_STAGES,
	type FirstRunState,
	type FirstRunStep,
	firstRunStage,
	firstRunStep,
} from "#/domain/first-run";
import type { RepositoryChoice } from "#/domain/projects";
import { YtimesyBrand } from "../auth/onboarding-shell";
import { AddProjectForm } from "../projects/add-project-form";
import { requestJson } from "../projects/api";
import { useGithubConnectionNotice } from "../projects/github-connection-notice";
import { ChatgptSignIn } from "../sessions/chatgpt-sign-in";
import { CodexMark } from "../sessions/codex-mark";
import { ModelConnections } from "../sessions/model-connections";
import { getModelConnections } from "../sessions/model-connections.fn";
import { ModelProviderLogo } from "../sessions/model-provider-logo";
import "./first-run.css";

const STAGE_LABELS = {
	github: "GitHub",
	repositories: "Repositories",
	model: "Model",
} as const;

const HEADINGS: Record<FirstRunStep, { title: string; lede: string }> = {
	github: {
		title: "Connect GitHub",
		lede: "ytimesy works in your repositories through its GitHub app.",
	},
	install: {
		title: "Connect GitHub",
		lede: "ytimesy works in your repositories through its GitHub app.",
	},
	repositories: {
		title: "Choose repositories",
		lede: "Pick the ones for your first project.",
	},
	model: {
		title: "Choose a model",
		lede: "Use your Codex subscription or your own API key.",
	},
};

function enterWorkspace() {
	window.location.assign("/");
}

/**
 * A new account's first run, before its first project: GitHub (sign in and
 * install the app), then the repositories, then a model (skippable). The
 * server says where it stands, so the right step paints first.
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
		// The app is installed in another tab; pick it up on return.
		refetchOnWindowFocus: true,
	});
	const githubConnected = repositories.isPending
		? state.githubConnected
		: Boolean(repositories.data);
	const step = firstRunStep({
		githubConnected,
		repositoryCount: repositories.data?.repositories.length ?? null,
		projectAdded,
	});
	const stage = firstRunStage(step);
	return (
		<main className="first-run">
			<header className="first-run-top">
				<YtimesyBrand />
			</header>
			<section className="first-run-card" aria-labelledby="first-run-title">
				<ol
					className="first-run-progress"
					aria-label={`Setup, ${STAGE_LABELS[FIRST_RUN_STAGES[stage]]}`}
				>
					{FIRST_RUN_STAGES.map((id, index) => (
						<li
							key={id}
							data-state={
								index < stage ? "done" : index === stage ? "current" : undefined
							}
							aria-current={index === stage ? "step" : undefined}
						>
							{STAGE_LABELS[id]}
						</li>
					))}
				</ol>
				<div className="first-run-heading">
					<h1 id="first-run-title">{HEADINGS[step].title}</h1>
					<p>{HEADINGS[step].lede}</p>
				</div>
				{step === "model" ? (
					<ModelStep ready={state.modelReady} />
				) : step === "github" || step === "install" ? (
					<GithubStep
						signedIn={step === "install"}
						installationUrl={repositories.data?.installationUrl}
					/>
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

/**
 * Two parts: sign in with GitHub (OAuth through the app), then install the
 * app on the repositories ytimesy may work in. Signing in alone reaches none.
 */
function GithubStep({
	signedIn,
	installationUrl,
}: {
	signedIn: boolean;
	installationUrl: string | undefined;
}) {
	const [notice] = useGithubConnectionNotice();
	const connect = useMutation({
		mutationFn: () => requestJson<{ url: string }>("/api/github/connect", {}),
		onSuccess: ({ url }) => window.location.assign(url),
	});
	const [installOpened, setInstallOpened] = useState(false);
	return (
		<>
			{notice ? <p role="alert">{notice}</p> : null}
			{connect.error ? <p role="alert">{connect.error.message}</p> : null}
			<ol className="first-run-tasks">
				<li data-done={signedIn || undefined}>
					<span className="first-run-task-icon">
						<GitHubMark />
					</span>
					<span className="first-run-task-copy">
						<strong>Sign in with GitHub</strong>
						<small>Links your GitHub account</small>
					</span>
					{signedIn ? (
						<span className="first-run-connected">
							<Check size={14} strokeWidth={2.6} />
							Connected
						</span>
					) : (
						<button
							type="button"
							className="first-run-primary"
							disabled={connect.isPending}
							onClick={() => connect.mutate()}
						>
							{connect.isPending ? "Opening GitHub…" : "Connect"}
						</button>
					)}
				</li>
				<li data-pending={!signedIn || undefined}>
					<span className="first-run-task-icon">
						<img src="/brand/mark.svg" width={16} height={16} alt="" />
					</span>
					<span className="first-run-task-copy">
						<strong>Install the ytimesy app</strong>
						<small>
							{installOpened
								? "Finish on GitHub. This page updates on its own."
								: "Give it access to your repositories"}
						</small>
					</span>
					{signedIn && installationUrl ? (
						<a
							className={
								installOpened ? "first-run-secondary" : "first-run-primary"
							}
							href={installationUrl}
							target="_blank"
							rel="noreferrer"
							onClick={() => setInstallOpened(true)}
						>
							Install
							<ArrowUpRight size={14} />
						</a>
					) : (
						<span className="first-run-task-wait">After sign-in</span>
					)}
				</li>
			</ol>
		</>
	);
}

function GitHubMark() {
	return (
		<svg
			width={16}
			height={16}
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
		</svg>
	);
}

export function ModelStep({ ready: readyAtLoad }: { ready: boolean }) {
	const readConnections = useServerFn(getModelConnections);
	const [chatgptConnected, setChatgptConnected] = useState(false);
	const [addingKey, setAddingKey] = useState(false);
	const connections = useQuery({
		queryKey: ["model-connections"],
		queryFn: () => readConnections(),
	});
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
					<ChatgptSignIn onConnected={() => setChatgptConnected(true)} />
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
					<ModelConnections startAdding />
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
