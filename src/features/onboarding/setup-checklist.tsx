import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronUp, Layers, SquareTerminal } from "lucide-react";
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
import { GithubMark } from "../workspace/github-mark";
import { GithubOptions, ModelOptions, SessionsOptions } from "./setup-options";
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

const STEP_ICON: Record<SetupStepId, React.ReactNode> = {
	github: <GithubMark size={16} />,
	// Layers: choose between plans and keys.
	model: <Layers size={17} strokeWidth={1.7} />,
	// A local agent's terminal session.
	sessions: <SquareTerminal size={17} strokeWidth={1.7} />,
};

/**
 * A step's icon in a soft tile. A finished step gets a check badge, the
 * current one a brighter edge, and a later one is dimmed.
 */
function StepIcon({
	id,
	status,
}: {
	id: SetupStepId;
	status: SetupStepStatus;
}) {
	return (
		<span
			aria-hidden="true"
			data-status={status}
			className={cn(
				"relative grid size-9 shrink-0 place-items-center rounded-xl bg-foreground/[0.06] text-foreground/80 ring-1 ring-foreground/10 transition-colors",
				status === "current" &&
					"bg-foreground/10 text-foreground ring-foreground/30",
				(status === "todo" || status === "skipped") && "text-muted-foreground",
			)}
		>
			{STEP_ICON[id]}
			{status === "done" || status === "skipped" ? (
				<span
					className={cn(
						"absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full ring-2 ring-card",
						status === "done"
							? "bg-primary text-primary-foreground"
							: "bg-muted text-muted-foreground",
					)}
				>
					{status === "done" ? (
						<Check size={10} strokeWidth={3.5} />
					) : (
						<span className="text-[0.625rem] leading-none">–</span>
					)}
				</span>
			) : null}
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
	// Nothing until every answer is in: GitHub only counts as done once the
	// repository list has loaded, so deciding earlier flashes the card at
	// someone who finished setup long ago.
	if (!userId || !prefs || !state.data || repositories.isPending) return null;

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
	// Hiding folds the card into one line instead of losing it for good.
	if (prefs.hidden)
		return (
			<SetupChecklistBar
				progress={progress}
				onShow={() => update({ ...prefs, hidden: false })}
			/>
		);
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
	const percent = Math.round((progress.settled / progress.total) * 100);
	const stepNumber = Math.min(progress.settled + 1, progress.total);
	return (
		<section
			aria-labelledby="setup-title"
			className="mx-auto mb-3 w-full max-w-[44rem] overflow-hidden rounded-2xl bg-gradient-to-b from-card to-card/90 text-[0.8125rem] text-card-foreground shadow-xl shadow-black/30 ring-1 ring-foreground/10"
		>
			<div className="flex items-start gap-4 px-6 pt-5 pb-4">
				<div className="min-w-0">
					<p className="mb-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
						Step {stepNumber} of {progress.total}
					</p>
					<h2
						id="setup-title"
						className="text-base font-semibold tracking-tight"
					>
						Get set up
					</h2>
					<p className="mt-0.5 text-muted-foreground">
						{progress.settled === 0
							? "A few quick steps. You can type your request now."
							: `${progress.total - progress.settled} to go.`}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="ml-auto text-muted-foreground"
					onClick={onHide}
				>
					Hide
				</Button>
			</div>
			<div
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={progress.total}
				aria-valuenow={progress.settled}
				aria-label="Setup progress"
				className="mx-6 h-1 overflow-hidden rounded-full bg-foreground/10"
			>
				<div
					className="h-full rounded-full bg-primary transition-[width] duration-500"
					style={{ width: `${percent}%` }}
				/>
			</div>
			<ol className="mt-3 pb-2">
				{progress.steps.map((step) => {
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
						<li key={step.id}>
							<div
								className={cn(
									"grid grid-cols-[2.25rem_1fr_auto] items-center gap-4 px-6 py-3.5",
									step.status === "todo" && "opacity-70",
								)}
							>
								<StepIcon id={step.id} status={step.status} />
								<div className="min-w-0">
									<p className="flex items-center gap-2 text-sm font-medium">
										{copy.title}
										{step.optional ? (
											<span className="rounded-full bg-foreground/[0.07] px-2 py-px text-[0.625rem] font-normal text-muted-foreground">
												Optional
											</span>
										) : null}
									</p>
									<p className="mt-0.5 text-muted-foreground">{note}</p>
								</div>
								{step.optional &&
								(step.status === "current" || step.status === "todo") ? (
									<div className="flex items-center gap-1.5">
										<Button
											type="button"
											size="lg"
											variant="ghost"
											className="text-muted-foreground"
											onClick={onSessionsDone}
										>
											Skip
										</Button>
										<Button
											type="button"
											size="lg"
											variant="outline"
											aria-expanded={expanded}
											onClick={() => onToggle(step.id)}
										>
											{copy.action}
										</Button>
									</div>
								) : step.status === "current" || step.status === "todo" ? (
									<Button
										type="button"
										size="lg"
										variant={step.status === "current" ? "default" : "outline"}
										aria-expanded={expanded}
										onClick={() => onToggle(step.id)}
									>
										{copy.action}
									</Button>
								) : null}
							</div>
							{expanded ? (
								<div className="px-6 pb-5 pl-[4.75rem]">
									<div className="rounded-xl bg-foreground/[0.03] p-3.5 ring-1 ring-foreground/[0.06]">
										{step.id === "github" ? (
											<GithubOptions
												signedIn={data.githubConnected}
												checking={data.githubConnected && repositoriesLoading}
												installationUrl={installationUrl}
											/>
										) : step.id === "model" ? (
											<ModelOptions
												ready={data.modelReady}
												xaiSubscription={data.xaiSubscription}
												claudeSubscription={data.claudeSubscription}
												onDone={onModelDone}
											/>
										) : (
											<SessionsOptions onSkip={onSessionsDone} />
										)}
									</div>
								</div>
							) : null}
						</li>
					);
				})}
			</ol>
		</section>
	);
}

/** The card folded into one line: what is left, and a way to open it again. */
export function SetupChecklistBar({
	progress,
	onShow,
}: {
	progress: SetupProgress;
	onShow: () => void;
}) {
	const percent = Math.round((progress.settled / progress.total) * 100);
	return (
		<button
			type="button"
			onClick={onShow}
			aria-label="Show the setup steps"
			className="group mx-auto mb-3 flex w-full max-w-[44rem] items-center gap-3 rounded-xl bg-card px-4 py-2.5 text-left text-[0.8125rem] text-card-foreground shadow-md shadow-black/20 ring-1 ring-foreground/10 transition-colors hover:bg-foreground/[0.04]"
		>
			<span className="font-medium">Finish setup</span>
			<span className="text-muted-foreground">
				{progress.settled} of {progress.total} done
			</span>
			<span
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={progress.total}
				aria-valuenow={progress.settled}
				aria-label="Setup progress"
				className="ml-auto hidden h-1 w-24 overflow-hidden rounded-full bg-foreground/10 sm:block"
			>
				<span
					className="block h-full rounded-full bg-primary"
					style={{ width: `${percent}%` }}
				/>
			</span>
			<ChevronUp
				size={15}
				className="text-muted-foreground transition-transform group-hover:text-foreground"
			/>
		</button>
	);
}
