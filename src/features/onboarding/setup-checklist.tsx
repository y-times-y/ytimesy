import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import type { FirstRunState } from "#/domain/first-run";
import type { RepositoryChoice } from "#/domain/projects";
import {
	type SetupProgress,
	type SetupStepId,
	type SetupStepStatus,
	setupProgress,
} from "#/domain/setup-steps";
import { cn } from "#/lib/utils";
import { authClient } from "../auth/client";
import { requestJson } from "../projects/api";
import { GithubStep, ModelStep, SessionsStep } from "./first-run";
import { readSetupPrefs, writeSetupPrefs } from "./setup-prefs";
import { getSetupState } from "./setup-state.fn";

const COPY: Record<
	SetupStepId,
	{ title: string; blurb: string; action: string }
> = {
	github: {
		title: "Connect GitHub",
		blurb: "ytimesy works in your repositories through its GitHub app.",
		action: "Connect",
	},
	model: {
		title: "Choose a model",
		blurb: "Use a plan you already pay for, or your own API key.",
		action: "Choose",
	},
	sessions: {
		title: "Bring your agent sessions",
		blurb: "Continue a local agent's work here.",
		action: "Import",
	},
};

/** A plain numbered circle: a check when done, the number otherwise. */
function StepCircle({
	status,
	number,
}: {
	status: SetupStepStatus;
	number: number;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"grid size-5 shrink-0 place-items-center rounded-full border-[1.5px] text-[0.625rem] font-semibold",
				status === "done" &&
					"border-primary bg-primary text-primary-foreground",
				status === "current" && "border-foreground text-foreground",
				(status === "todo" || status === "skipped") &&
					"border-foreground/25 text-muted-foreground",
			)}
		>
			{status === "done" ? (
				<Check size={11} strokeWidth={3} />
			) : status === "skipped" ? (
				"–"
			) : (
				number
			)}
		</span>
	);
}

/**
 * The setup card above a new chat's composer: GitHub, a model and (optional)
 * local sessions, each opening in place. It shows only while something is
 * left, never blocks the composer, and the person can hide it.
 */
export function SetupChecklist() {
	const session = authClient.useSession();
	const userId = session.data?.user.id;
	const readState = useServerFn(getSetupState);
	const state = useQuery({
		queryKey: ["setup-state", userId],
		queryFn: () => readState(),
		enabled: Boolean(userId),
		staleTime: 15_000,
	});
	// Same read as the project picker: connected once it lists repositories.
	const repositories = useQuery({
		queryKey: ["github", "repositories"],
		queryFn: () =>
			requestJson<{
				repositories: RepositoryChoice[];
				installationUrl: string;
			}>("/api/github/repositories"),
		retry: false,
		refetchOnWindowFocus: true,
		enabled: Boolean(userId),
	});
	const [prefs, setPrefs] = useState<{
		hidden: boolean;
		sessionsSkipped: boolean;
	} | null>(null);
	const [open, setOpen] = useState<SetupStepId | null>(null);
	// Read after hydration: the server cannot know this browser's choices.
	useEffect(() => {
		if (userId) setPrefs(readSetupPrefs(window.localStorage, userId));
	}, [userId]);
	if (!userId || !prefs || !state.data || prefs.hidden) return null;

	const data: FirstRunState = state.data;
	const progress = setupProgress({
		state: data,
		repositoryCount: repositories.data
			? repositories.data.repositories.length
			: null,
		sessionsSkipped: prefs.sessionsSkipped,
	});
	if (progress.complete) return null;

	function update(next: { hidden: boolean; sessionsSkipped: boolean }) {
		setPrefs(next);
		if (userId) writeSetupPrefs(window.localStorage, userId, next);
	}
	return (
		<SetupChecklistView
			progress={progress}
			state={data}
			installationUrl={repositories.data?.installationUrl}
			repositoriesLoading={repositories.isPending}
			open={open}
			onToggle={(id) => setOpen((current) => (current === id ? null : id))}
			onHide={() => update({ ...prefs, hidden: true })}
			onModelDone={() => {
				setOpen(null);
				void state.refetch();
			}}
			onSessionsDone={() => {
				setOpen(null);
				update({ ...prefs, sessionsSkipped: true });
			}}
		/>
	);
}

/** The card itself, from plain props. */
export function SetupChecklistView({
	progress,
	state: data,
	installationUrl,
	repositoriesLoading,
	open,
	onToggle,
	onHide,
	onModelDone,
	onSessionsDone,
}: {
	progress: SetupProgress;
	state: FirstRunState;
	installationUrl: string | undefined;
	repositoriesLoading: boolean;
	open: SetupStepId | null;
	onToggle: (id: SetupStepId) => void;
	onHide: () => void;
	onModelDone: () => void;
	onSessionsDone: () => void;
}) {
	const percent = Math.round((progress.settled / progress.steps.length) * 100);
	return (
		<section
			aria-labelledby="setup-title"
			className="mx-auto mb-3 w-full max-w-[44rem] overflow-hidden rounded-xl bg-card text-xs text-card-foreground ring-1 ring-foreground/10"
		>
			<div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
				<div className="min-w-0">
					<h2 id="setup-title" className="text-[0.8125rem] font-semibold">
						Get set up
					</h2>
					<p className="text-muted-foreground">
						{progress.settled === 0
							? "Three quick steps. You can type your request now."
							: `${progress.steps.length - progress.settled} to go.`}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="ml-auto"
					onClick={onHide}
				>
					Hide
				</Button>
			</div>
			<div
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={progress.steps.length}
				aria-valuenow={progress.settled}
				aria-label="Setup progress"
				className="h-[3px] bg-muted"
			>
				<div
					className="h-full bg-primary transition-[width] duration-500"
					style={{ width: `${percent}%` }}
				/>
			</div>
			<ol>
				{progress.steps.map((step, index) => {
					const copy = COPY[step.id];
					const expanded =
						open === step.id &&
						step.status !== "done" &&
						step.status !== "skipped";
					const note =
						step.status === "done"
							? step.id === "github"
								? "Connected"
								: "Ready"
							: step.status === "skipped"
								? "Skipped. Import any time from Settings."
								: copy.blurb;
					return (
						<li key={step.id} className="border-t border-foreground/10">
							<div className="grid grid-cols-[1.25rem_1fr_auto] items-center gap-3 px-4 py-3">
								<StepCircle status={step.status} number={index + 1} />
								<div className="min-w-0">
									<p className="flex items-center gap-1.5 font-medium">
										{copy.title}
										{step.optional ? (
											<span className="rounded-full border border-foreground/15 px-1.5 text-[0.625rem] font-normal text-muted-foreground">
												Optional
											</span>
										) : null}
									</p>
									<p className="text-muted-foreground">{note}</p>
								</div>
								{step.status === "current" || step.status === "todo" ? (
									<Button
										type="button"
										size="sm"
										variant={step.status === "current" ? "default" : "outline"}
										aria-expanded={expanded}
										onClick={() => onToggle(step.id)}
									>
										{copy.action}
									</Button>
								) : null}
							</div>
							{expanded ? (
								<div className="px-4 pb-4 pl-12 [&_.first-run-actions]:mt-3">
									{step.id === "github" ? (
										<GithubStep
											signedIn={data.githubConnected}
											checking={data.githubConnected && repositoriesLoading}
											installationUrl={installationUrl}
										/>
									) : step.id === "model" ? (
										<ModelStep
											ready={data.modelReady}
											xaiSubscription={data.xaiSubscription}
											claudeSubscription={data.claudeSubscription}
											onDone={onModelDone}
										/>
									) : (
										<SessionsStep onDone={onSessionsDone} />
									)}
								</div>
							) : null}
						</li>
					);
				})}
			</ol>
		</section>
	);
}
