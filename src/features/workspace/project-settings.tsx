import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	Archive,
	Blocks,
	BookMarked,
	Bot,
	Folder,
	Gauge,
	Import,
	Mail,
	Plug,
	Shield,
	User,
	X,
} from "lucide-react";
import { ScrollArea } from "radix-ui";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MenuSelect } from "#/components/ui/menu-select";
import {
	accountDeletionConfirmed,
	accountDeletionPhrase,
} from "#/domain/account-deletion";
import type { CodexUsage } from "#/domain/codex-usage";
import type {
	ProjectSecretKind,
	PublicProjectSecret,
} from "#/domain/project-secret";
import { type Project, projectDisplayName } from "#/domain/projects";
import {
	memberSince,
	SIGN_IN_METHOD_LABELS,
	type SignInMethod,
} from "#/domain/sign-in-methods";
import type { UserAgentAccount } from "#/domain/user-agent-account";
import {
	accountDisplayName,
	accountInitials,
	type SettingsSection,
	settingsNavItems,
} from "#/domain/workspace-settings";
import {
	type XaiSubscriptionView,
	xaiSubscriptionMessage,
} from "#/domain/xai-subscription";
import { ReplayChoiceSection } from "#/features/analytics/replay-choice-setting";
import { authClient } from "../auth/client";
import { ContinueSessionCard } from "../local-import/continue-session-card";
import { PastImports } from "../local-import/past-imports";
import { AddProjectForm } from "../projects/add-project-form";
import { requestJson } from "../projects/api";
import { clearChatCache } from "../sessions/chat-cache";
import { ChatgptSignIn, DeviceCodeHint } from "../sessions/chatgpt-sign-in";
import { getClaudeSubscription } from "../sessions/claude-subscription.fn";
import { ClaudeSubscriptionSettings } from "../sessions/claude-subscription-settings";
import { CodexMark } from "../sessions/codex-mark";
import {
	ClaudeSubscriptionUsage,
	CodexSubscriptionUsage,
	GrokSubscriptionUsage,
} from "../sessions/codex-usage";
import { GrokMark } from "../sessions/grok-mark";
import { McpServers } from "../sessions/mcp-servers";
import { ModelConnections } from "../sessions/model-connections";
import { ModelFailoverSettings } from "../sessions/model-failover-settings";
import { Plugins } from "../sessions/plugins";
import { disconnectXaiSubscriptionFn } from "../sessions/xai-subscription.fn";
import { XaiSubscriptionSignIn } from "../sessions/xai-subscription-sign-in";
import { ArchivedSettings } from "./archived-settings";
import { DefaultBranchPushSettings } from "./default-branch-push-settings";
import { EnvironmentSettings } from "./environment-settings";
import { GithubMark } from "./github-mark";
import { InfrastructureUsage } from "./infrastructure-usage";
import { MachineSizeSettings } from "./machine-size-settings";
import { MemorySettings } from "./memory-settings";
import { NetworkAccessSettings } from "./network-access-settings";
import {
	deleteAccountSecretFn,
	deleteProjectSecretFn,
	listAccountSecretsFn,
	listProjectSecretsFn,
	saveProjectSecretFn,
} from "./project-secrets.fn";
import { prefetchSettings } from "./settings-prefetch";
import { codexSubscriptionUsageFn } from "./subscription-usage.fn";
import {
	ProjectTrainingSettings,
	TrainingConsentSettings,
} from "./training-consent-settings";

type AccountView = {
	readonly user: {
		readonly name?: string | null;
		readonly email?: string | null;
		readonly image?: string | null;
		readonly createdAt?: string | null;
	};
	/** How this account signs in (absent from an older server). */
	readonly signInMethods?: readonly SignInMethod[];
	readonly githubConnected: boolean;
	readonly agentAccount: UserAgentAccount;
	/** Absent while the SuperGrok feature switch is off. */
	readonly xaiSubscription?: XaiSubscriptionView;
};

const sectionIcon = {
	account: User,
	privacy: Shield,
	memory: BookMarked,
	github: GithubMark,
	import: Import,
	project: Folder,
	agents: Bot,
	plugins: Blocks,
	mcp: Plug,
	usage: Gauge,
	archived: Archive,
} as const;

export function ProjectSettings({
	open,
	projectId,
	projects,
	selectedProject,
	onProjectAdded,
	onSignOut,
	onSetUpEnvironment,
	onClose,
	initialSection,
}: {
	open: boolean;
	/** The section to show when the panel opens, e.g. after an OAuth round trip. */
	initialSection?: SettingsSection;
	codexUsage?: CodexUsage;
	projectId?: string;
	projects: readonly Project[];
	selectedProject?: Project;
	onProjectAdded: (project: Project) => void;
	onSignOut: () => void;
	/** Starts a new chat in that project with the environment setup request. */
	onSetUpEnvironment?: (projectId: string) => void;
	onClose: () => void;
}) {
	const [section, setSection] = useState<SettingsSection>("account");
	useEffect(() => {
		if (open && initialSection) setSection(initialSection);
	}, [open, initialSection]);
	const [settingsProjectId, setSettingsProjectId] = useState<string>();
	// Each opening starts on the project in view; a project picked in an
	// earlier opening does not stick.
	useEffect(() => {
		if (open) setSettingsProjectId(undefined);
	}, [open]);
	const readSubscriptionUsage = useServerFn(codexSubscriptionUsageFn);
	// Shared with the model picker's plan line (plan-usage.tsx).
	useQuery({
		queryKey: ["codex-subscription-usage"],
		queryFn: () => readSubscriptionUsage(),
		// Read with the panel, so Agents shows at its full height when picked.
		enabled: open,
		staleTime: 30_000,
		refetchInterval: open && section === "agents" ? 60_000 : false,
		retry: false,
	});
	const account = useQuery({
		queryKey: ["account"],
		queryFn: () => requestJson<AccountView>("/api/account"),
		enabled: open,
		staleTime: 60_000,
	});
	// The sections' saved values are read ahead: once while the app is idle
	// and again when the panel opens (or another project is picked), so a
	// section shows its switches as saved the moment it is picked.
	const queryClient = useQueryClient();
	const prefetchProjectId =
		settingsProjectId ?? selectedProject?.id ?? projectId;
	useEffect(() => {
		if (open) prefetchSettings(queryClient, prefetchProjectId);
	}, [open, prefetchProjectId, queryClient]);
	const idleProjectId = selectedProject?.id ?? projectId;
	useEffect(() => {
		const read = () => prefetchSettings(queryClient, idleProjectId);
		if (typeof window.requestIdleCallback === "function") {
			const handle = window.requestIdleCallback(read, { timeout: 4000 });
			return () => window.cancelIdleCallback(handle);
		}
		const timer = setTimeout(read, 1500);
		return () => clearTimeout(timer);
	}, [idleProjectId, queryClient]);

	useEffect(() => {
		if (!open) return;
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") onClose();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	if (!open) return null;

	const user = account.data?.user;
	const githubConnected = account.data?.githubConnected ?? false;
	const currentProject =
		selectedProject ?? projects.find((row) => row.id === projectId);
	const settingsProject =
		projects.find((row) => row.id === settingsProjectId) ?? currentProject;

	return createPortal(
		<div className="settings-overlay">
			<button
				type="button"
				className="settings-backdrop"
				aria-label="Close settings"
				onClick={onClose}
			/>
			<section className="settings-panel" aria-label="Settings">
				<header className="settings-panel-head">
					<h2>Settings</h2>
					<button
						type="button"
						className="settings-close"
						aria-label="Close settings"
						onClick={onClose}
					>
						<X size={16} />
					</button>
				</header>
				<div className="settings-shell">
					<nav className="settings-nav" aria-label="Settings sections">
						{settingsNavItems().map((item) => {
							const Icon = sectionIcon[item.id];
							return (
								<button
									key={item.id}
									type="button"
									aria-current={section === item.id ? "page" : undefined}
									onClick={() => setSection(item.id)}
								>
									<Icon size={16} strokeWidth={1.5} />
									{item.label}
								</button>
							);
						})}
					</nav>
					<ScrollArea.Root className="settings-scroll-root">
						<ScrollArea.Viewport className="settings-scroll-viewport">
							<div className="settings-body">
								{section === "account" ? (
									<AccountSection
										loading={account.isPending}
										error={account.error?.message}
										user={user}
										signInMethods={account.data?.signInMethods}
										onSignOut={onSignOut}
									/>
								) : null}
								{section === "privacy" ? (
									<>
										<TrainingConsentSettings />
										<ReplayChoiceSection />
									</>
								) : null}
								{section === "memory" ? <MemorySettings /> : null}
								{section === "archived" ? <ArchivedSettings /> : null}
								{section === "usage" ? (
									<UsageSection
										planConnected={
											account.data?.agentAccount.status === "connected"
										}
										grokConnected={
											(account.data?.xaiSubscription?.status ??
												"disconnected") !== "disconnected"
										}
									/>
								) : null}
								{section === "github" ? (
									<GithubSection
										loading={account.isPending}
										connected={githubConnected}
										projects={projects}
										onProjectAdded={onProjectAdded}
									/>
								) : null}
								{section === "import" ? (
									<section className="settings-section">
										<SettingsHeader
											title="Import"
											description="Continue local agent sessions here."
											details="Copy the prompt into Claude Code, Codex, Cursor or another local agent. It runs one command that pushes your work to a ytimesy branch and opens a chat with the session's history."
										/>
										{account.isPending ? (
											<p className="settings-copy">Loading…</p>
										) : (
											<ContinueSessionCard githubConnected={githubConnected} />
										)}
										<PastImports />
									</section>
								) : null}
								{section === "project" ? (
									settingsProject ? (
										<ProjectPage
											key={settingsProject.id}
											project={settingsProject}
											projects={projects}
											onSelect={setSettingsProjectId}
											onSetUpEnvironment={onSetUpEnvironment}
										/>
									) : (
										<section className="settings-section">
											<SettingsHeader
												title="Project"
												description="Add a repository first."
											/>
										</section>
									)
								) : null}
								{section === "plugins" ? <Plugins /> : null}
								{section === "mcp" ? <McpServers /> : null}
								{section === "agents" ? (
									<AgentsSection
										account={
											account.data?.agentAccount ?? { status: "disconnected" }
										}
										xaiSubscription={account.data?.xaiSubscription}
									/>
								) : null}
							</div>
						</ScrollArea.Viewport>
						<ScrollArea.Scrollbar
							orientation="vertical"
							className="settings-scrollbar"
						>
							<ScrollArea.Thumb className="settings-scroll-thumb" />
						</ScrollArea.Scrollbar>
					</ScrollArea.Root>
				</div>
			</section>
		</div>,
		document.body,
	);
}

/**
 * Settings > Project: one repository's settings, picked at the top. Every
 * part is a titled section over a card group, like the other pages.
 */
function ProjectPage({
	project,
	projects,
	onSelect,
	onSetUpEnvironment,
}: {
	project: Project;
	projects: readonly Project[];
	onSelect: (projectId: string) => void;
	onSetUpEnvironment?: (projectId: string) => void;
}) {
	return (
		<>
			<section className="settings-section" aria-label="Project">
				<SettingsHeader
					title="Project"
					description="Settings per repository."
				/>
				<div className="settings-group">
					<div className="settings-row">
						<div className="settings-row-main">
							<span className="settings-row-icon">
								<GithubMark size={16} />
							</span>
							<div className="settings-row-text">
								<span className="settings-row-title">
									{projectDisplayName(project)}
								</span>
								<span className="settings-row-meta">
									{project.fullName} · {project.branch}
								</span>
							</div>
						</div>
						{projects.length > 1 ? (
							<div className="settings-row-actions">
								<MenuSelect
									value={project.id}
									onValueChange={onSelect}
									valueLabel="Switch project"
									options={projects.map((row) => ({
										value: row.id,
										label: projectDisplayName(row),
										title: row.fullName,
									}))}
									className="settings-project-select"
									align="end"
									aria-label="Project"
								/>
							</div>
						) : null}
					</div>
				</div>
			</section>
			<EnvironmentSettings
				projectId={project.id}
				onSetUpWithAgent={
					onSetUpEnvironment ? () => onSetUpEnvironment(project.id) : undefined
				}
			/>
			<MachineSizeSettings projectId={project.id} />
			<NetworkAccessSettings projectId={project.id} />
			<DefaultBranchPushSettings
				projectId={project.id}
				branch={project.branch}
			/>
			<ProjectSecretsSection project={project} />
			<AccountSecretsSection />
			<ProjectTrainingSettings projectId={project.id} />
		</>
	);
}

function SettingsHeader({
	title,
	description,
	details,
	action,
}: {
	title: string;
	/** One short line. */
	description?: string;
	/** The fine print, shown as the description's tooltip. */
	details?: string;
	action?: ReactNode;
}) {
	return (
		<header className="settings-section-head">
			<div>
				<h3>{title}</h3>
				{description ? <p title={details}>{description}</p> : null}
			</div>
			{action}
		</header>
	);
}

function AccountSection({
	loading,
	error,
	user,
	signInMethods,
	onSignOut,
}: {
	loading: boolean;
	error?: string;
	user?: AccountView["user"];
	signInMethods?: readonly SignInMethod[];
	onSignOut: () => void;
}) {
	if (loading) return <p className="settings-copy">Loading account…</p>;
	if (error) return <p role="alert">{error}</p>;
	const since = user?.createdAt ? memberSince(user.createdAt) : null;
	return (
		<div className="settings-account">
			<section className="settings-section">
				<SettingsHeader title="Account" description="Your ytimesy sign-in." />
				<div className="settings-group">
					<div className="settings-row">
						<div className="settings-row-main settings-identity">
							{user?.image ? (
								<img src={user.image} width={40} height={40} alt="" />
							) : (
								<span className="settings-initials" aria-hidden="true">
									{accountInitials(user ?? {})}
								</span>
							)}
							<div className="settings-row-text">
								<span className="settings-row-title">
									{accountDisplayName(user ?? {})}
								</span>
								{user?.email ? (
									<span className="settings-row-meta">{user.email}</span>
								) : null}
							</div>
						</div>
					</div>
					{since ? (
						<div className="settings-row">
							<span className="settings-row-title">Member since</span>
							<span className="settings-row-value">{since}</span>
						</div>
					) : null}
				</div>
			</section>
			{signInMethods?.length ? (
				<section className="settings-section" aria-label="Sign-in methods">
					<SettingsHeader
						title="Sign-in methods"
						description="Ways you can sign in."
					/>
					<ul className="settings-group">
						{signInMethods.map((method) => (
							<li key={method} className="settings-row">
								<div className="settings-row-main">
									<span className="settings-row-icon">
										{method === "github" ? (
											<GithubMark size={16} />
										) : method === "google" ? (
											<GoogleMark size={15} />
										) : (
											<Mail size={16} strokeWidth={1.5} />
										)}
									</span>
									<div className="settings-row-text">
										<span className="settings-row-title">
											{SIGN_IN_METHOD_LABELS[method]}
										</span>
										{method === "email" && user?.email ? (
											<span className="settings-row-meta">{user.email}</span>
										) : null}
									</div>
								</div>
								<span className="settings-badge" data-tone="ok">
									Linked
								</span>
							</li>
						))}
					</ul>
				</section>
			) : null}
			<section className="settings-section" aria-label="Session">
				<SettingsHeader title="Session" />
				<div className="settings-group">
					<div className="settings-row">
						<div className="settings-row-text">
							<span className="settings-row-title">Sign out</span>
							<span className="settings-row-meta">On this browser only.</span>
						</div>
						<div className="settings-row-actions">
							<button
								type="button"
								className="settings-secondary"
								onClick={onSignOut}
							>
								Sign out
							</button>
						</div>
					</div>
				</div>
			</section>
			<DeleteAccount email={user?.email} />
		</div>
	);
}

/** Google's "G" in its own colors (sign-in method row). */
function GoogleMark({ size = 16 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
			<path
				fill="#4285F4"
				d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z"
			/>
			<path
				fill="#34A853"
				d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24Z"
			/>
			<path
				fill="#FBBC05"
				d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29A11.97 11.97 0 0 0 0 12c0 1.94.46 3.77 1.29 5.38l3.98-3.09Z"
			/>
			<path
				fill="#EA4335"
				d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
			/>
		</svg>
	);
}

/** Permanent deletion behind a typed confirmation; signs out when done. */
function DeleteAccount({ email }: { email?: string | null }) {
	const [confirming, setConfirming] = useState(false);
	const [typed, setTyped] = useState("");
	const phrase = accountDeletionPhrase({ email });
	const confirmed = accountDeletionConfirmed({ email }, typed);
	const remove = useMutation({
		mutationFn: async () => {
			const response = await fetch("/api/account", {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmation: typed }),
			});
			if (!response.ok) {
				const text = await response.text();
				let message = text;
				try {
					message = JSON.parse(text).error ?? text;
				} catch {}
				throw new Error(message || "Your account could not be deleted.");
			}
		},
		onSuccess: async () => {
			await clearChatCache();
			await authClient.signOut().catch(() => undefined);
			window.location.assign("/auth/sign-in");
		},
	});
	return (
		<div className="settings-group settings-danger-zone">
			<div className="settings-row">
				<div className="settings-row-text">
					<span className="settings-row-title">Delete account</span>
					<span
						className="settings-row-meta"
						title="Deletes your projects, chats, cloud machines, saved files and connections. Your GitHub repositories are not touched."
					>
						Permanent. Your GitHub repositories stay.
					</span>
				</div>
				{confirming ? null : (
					<div className="settings-row-actions">
						<button
							type="button"
							className="settings-danger"
							onClick={() => setConfirming(true)}
						>
							Delete account
						</button>
					</div>
				)}
				{confirming ? (
					<form
						className="settings-confirm"
						onSubmit={(event) => {
							event.preventDefault();
							if (confirmed && !remove.isPending) remove.mutate();
						}}
					>
						<label className="settings-field settings-confirm-field">
							<span>
								Type <strong>{phrase}</strong> to confirm. This cannot be
								undone.
							</span>
							<input
								autoComplete="off"
								spellCheck={false}
								value={typed}
								disabled={remove.isPending}
								onChange={(event) => setTyped(event.target.value)}
							/>
						</label>
						<div className="settings-row-actions">
							<button
								type="button"
								className="settings-secondary"
								disabled={remove.isPending}
								onClick={() => {
									setConfirming(false);
									setTyped("");
									remove.reset();
								}}
							>
								Cancel
							</button>
							<button
								type="submit"
								className="settings-danger"
								disabled={!confirmed || remove.isPending}
							>
								{remove.isPending ? "Deleting…" : "Delete permanently"}
							</button>
						</div>
					</form>
				) : null}
			</div>
			{remove.error ? <p role="alert">{remove.error.message}</p> : null}
		</div>
	);
}

function GithubSection({
	loading,
	connected,
	projects,
	onProjectAdded,
}: {
	loading: boolean;
	connected: boolean;
	projects: readonly Project[];
	onProjectAdded: (project: Project) => void;
}) {
	const [adding, setAdding] = useState(false);
	const disconnect = useMutation({
		mutationFn: () =>
			requestJson<{ connected: boolean }>("/api/github/disconnect", {}),
		onSuccess: () => window.location.assign("/"),
	});
	const connect = useMutation({
		mutationFn: () => requestJson<{ url: string }>("/api/github/connect", {}),
		onSuccess: ({ url }) => window.location.assign(url),
	});
	if (loading) return <p className="settings-copy">Loading GitHub…</p>;
	return (
		<>
			<section className="settings-section">
				<SettingsHeader
					title="GitHub"
					description="Repository access for your projects."
				/>
				<div className="settings-group">
					<div className="settings-row">
						<div className="settings-row-main">
							<span className="settings-row-icon">
								<GithubMark size={16} />
							</span>
							<div className="settings-row-text">
								<span className="settings-row-title">ytimesy GitHub App</span>
								<span className="settings-row-meta">
									{connected
										? "Clones and pushes only the repositories you grant."
										: "Connect to add repositories."}
								</span>
							</div>
						</div>
						<div className="settings-row-actions">
							<span
								className="settings-badge"
								data-tone={connected ? "ok" : undefined}
							>
								{connected ? "Connected" : "Not connected"}
							</span>
							{connected ? (
								<button
									type="button"
									className="settings-secondary"
									disabled={disconnect.isPending}
									onClick={() => disconnect.mutate()}
								>
									{disconnect.isPending ? "Disconnecting…" : "Disconnect"}
								</button>
							) : (
								<button
									type="button"
									className="settings-primary"
									disabled={connect.isPending}
									onClick={() => connect.mutate()}
								>
									{connect.isPending ? "Opening GitHub…" : "Connect GitHub"}
								</button>
							)}
						</div>
					</div>
				</div>
				{disconnect.error || connect.error ? (
					<p role="alert">
						{disconnect.error?.message ?? connect.error?.message}
					</p>
				) : null}
			</section>
			<section className="settings-section">
				<SettingsHeader
					title="Repositories"
					description="Projects you work on in ytimesy."
					action={
						connected ? (
							<button
								type="button"
								className="settings-secondary"
								onClick={() => setAdding((value) => !value)}
							>
								{adding ? "Done" : "Add repository"}
							</button>
						) : undefined
					}
				/>
				<ul className="settings-group">
					{projects.length ? (
						projects.map((project) => (
							<li key={project.id} className="settings-row">
								<div className="settings-row-main">
									<span className="settings-row-icon">
										<Folder size={16} strokeWidth={1.5} />
									</span>
									<div className="settings-row-text">
										<span className="settings-row-title">
											{projectDisplayName(project)}
										</span>
										<span className="settings-row-meta">
											{project.fullName}
										</span>
									</div>
								</div>
								<span className="settings-chip" title={project.branch}>
									{project.branch}
								</span>
							</li>
						))
					) : (
						<li className="settings-empty">
							{connected
								? "No repositories yet. Use Add repository to choose one."
								: "Connect GitHub above, then add a repository."}
						</li>
					)}
				</ul>
				{adding ? (
					<AddProjectForm
						variant="settings"
						onAdded={(project) => {
							setAdding(false);
							onProjectAdded(project);
						}}
					/>
				) : null}
			</section>
		</>
	);
}

const SECRET_KIND_LABELS: Record<ProjectSecretKind, string> = {
	runtime: "Runtime secret",
	environment: "Environment variable",
	build: "Build secret",
};

const SECRET_KIND_HINTS: Record<ProjectSecretKind, string> = {
	runtime: "API keys the code needs; hidden from the agent.",
	environment: "Non-sensitive settings the agent can read.",
	build: "Only during environment setup, e.g. registry tokens.",
};

function ProjectSecretsSection({ project }: { project?: Project }) {
	const listSecrets = useServerFn(listProjectSecretsFn);
	const saveSecret = useServerFn(saveProjectSecretFn);
	const deleteSecret = useServerFn(deleteProjectSecretFn);
	const [secrets, setSecrets] = useState<readonly PublicProjectSecret[]>([]);
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [kind, setKind] = useState<ProjectSecretKind>("runtime");
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!project) {
			setSecrets([]);
			return;
		}
		void listSecrets({ data: { projectId: project.id } })
			.then(setSecrets)
			.catch((cause: unknown) => {
				setError(
					cause instanceof Error ? cause.message : "Could not load secrets.",
				);
			});
	}, [listSecrets, project]);

	async function onSave(event: FormEvent) {
		event.preventDefault();
		if (!project || busy) return;
		setBusy(true);
		setError(null);
		try {
			setSecrets(
				await saveSecret({
					data: { projectId: project.id, name, value, kind },
				}),
			);
			setName("");
			setValue("");
			setAdding(false);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not save secret.",
			);
		} finally {
			setBusy(false);
		}
	}

	/** The secret leaves the list at once; a failed removal brings it back. */
	async function onDelete(secretId: string) {
		if (!project || busy) return;
		const before = secrets;
		setBusy(true);
		setError(null);
		setSecrets(before.filter((secret) => secret.id !== secretId));
		try {
			setSecrets(
				await deleteSecret({
					data: { projectId: project.id, secretId },
				}),
			);
		} catch (cause) {
			setSecrets(before);
			setError(
				cause instanceof Error ? cause.message : "Could not remove secret.",
			);
		} finally {
			setBusy(false);
		}
	}

	if (!project) return null;

	return (
		<section className="settings-section">
			<SettingsHeader
				title="Secrets"
				description="Encrypted and never shown again."
				details="Environment variables and runtime secrets are loaded as environment variables for the agent and services. Runtime secret values (and common encodings of them) are redacted from what the model and this chat see on a best-effort basis, and commits containing them are refused. Build secrets are only passed to environment setup."
				action={
					<button
						type="button"
						className="settings-secondary"
						onClick={() => setAdding((open) => !open)}
					>
						{adding ? "Cancel" : "Add secret"}
					</button>
				}
			/>
			<ul className="settings-group">
				{secrets.length === 0 ? (
					<li className="settings-empty">No secrets yet.</li>
				) : (
					secrets.map((secret) => (
						<li key={secret.id} className="settings-row">
							<div className="settings-row-text">
								<code className="settings-row-title">{secret.name}</code>
								<span className="settings-row-meta">
									{SECRET_KIND_LABELS[secret.kind]} · {secret.hint}
									{secret.imported ? (
										<span
											className="settings-badge settings-secret-imported"
											title="Read from your local .env when you continued an agent session. Check it, then save it again here or remove it."
										>
											Imported
										</span>
									) : null}
								</span>
							</div>
							<button
								type="button"
								className="settings-secondary"
								onClick={() => void onDelete(secret.id)}
								disabled={busy}
							>
								Remove
							</button>
						</li>
					))
				)}
			</ul>
			{adding ? (
				<form
					className="settings-group settings-form-grid"
					onSubmit={(event) => void onSave(event)}
				>
					<label className="settings-field">
						<span>Name</span>
						<input
							autoComplete="off"
							spellCheck={false}
							placeholder="DATABASE_URL"
							value={name}
							onChange={(event) => setName(event.target.value.toUpperCase())}
						/>
					</label>
					<div className="settings-field">
						<span>Type</span>
						<MenuSelect
							value={kind}
							disabled={busy}
							onValueChange={(next) => setKind(next as ProjectSecretKind)}
							valueLabel={SECRET_KIND_LABELS[kind]}
							options={(
								Object.entries(SECRET_KIND_LABELS) as [
									ProjectSecretKind,
									string,
								][]
							).map(([id, label]) => ({
								value: id,
								label,
								title: SECRET_KIND_HINTS[id],
							}))}
							aria-label="Secret type"
						/>
					</div>
					<label className="settings-field">
						<span>Value</span>
						<input
							type="password"
							autoComplete="off"
							spellCheck={false}
							placeholder="Value"
							value={value}
							onChange={(event) => setValue(event.target.value)}
						/>
					</label>
					<div className="settings-form-actions">
						<button
							type="submit"
							className="settings-primary"
							disabled={busy || !name.trim() || !value.trim()}
						>
							{busy ? "Saving…" : "Save secret"}
						</button>
					</div>
				</form>
			) : null}
			{error ? <p role="alert">{error}</p> : null}
		</section>
	);
}

function UsageSection({
	planConnected,
	grokConnected,
}: {
	planConnected: boolean;
	grokConnected: boolean;
}) {
	const loadClaude = useServerFn(getClaudeSubscription);
	const claude = useQuery({
		queryKey: ["claude-subscription"],
		queryFn: () => loadClaude(),
		staleTime: 30_000,
	});
	const claudeConnected =
		claude.data?.enabled === true &&
		(claude.data.status === "connected" || claude.data.status === "limited");
	return (
		<>
			<section className="settings-section">
				<SettingsHeader
					title="Usage"
					description="What you've used and when it resets."
				/>
				{planConnected ? <CodexSubscriptionUsage /> : null}
				{claudeConnected ? <ClaudeSubscriptionUsage /> : null}
				{grokConnected ? <GrokSubscriptionUsage /> : null}
				{planConnected || claudeConnected || grokConnected ? null : (
					<div className="settings-group settings-empty">
						Connect a plan in Agents to see its usage.
					</div>
				)}
			</section>
			<InfrastructureUsage />
		</>
	);
}

function AgentsSection({
	account,
	xaiSubscription,
}: {
	account: UserAgentAccount;
	xaiSubscription?: XaiSubscriptionView;
}) {
	const queryClient = useQueryClient();
	const [confirmingSignOut, setConfirmingSignOut] = useState(false);
	const refreshAccount = () =>
		Promise.all(
			[
				["account"],
				["codex-subscription-usage"],
				["agent-model-catalog"],
				["model-connections"],
			].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
		);
	const signOut = useMutation({
		mutationFn: () =>
			requestJson<{ status: "disconnected" }>("/api/agent/account", {}),
		onSuccess: async () => {
			setConfirmingSignOut(false);
			await refreshAccount();
		},
	});
	const connected = account.status === "connected";
	const meta = connected
		? [account.planType ? `${account.planType} plan` : null, account.email]
				.filter(Boolean)
				.join(" · ") || "Connected"
		: account.status === "expired"
			? "Sign-in expired. Your chats are kept."
			: "Use your ChatGPT plan for Codex models.";
	return (
		<>
			<section className="settings-section">
				<SettingsHeader
					title="Models"
					description={
						xaiSubscription
							? "Your subscriptions or your API keys."
							: "Your Codex subscription or your API keys."
					}
				/>
				<ul className="settings-group">
					<li className="settings-row">
						<div className="settings-row-main">
							<span className="settings-row-icon">
								<CodexMark size={18} />
							</span>
							<div className="settings-row-text">
								<span className="settings-row-title">Codex subscription</span>
								<span className="settings-row-meta">{meta}</span>
								{/* Below the description, so the button column stays narrow. */}
								{connected ? null : <DeviceCodeHint />}
							</div>
						</div>
						<div className="settings-row-actions">
							{connected ? (
								confirmingSignOut ? (
									<>
										<button
											type="button"
											className="settings-secondary"
											disabled={signOut.isPending}
											onClick={() => setConfirmingSignOut(false)}
										>
											Cancel
										</button>
										<button
											type="button"
											className="settings-danger"
											disabled={signOut.isPending}
											onClick={() => signOut.mutate()}
										>
											{signOut.isPending ? "Signing out…" : "Sign out"}
										</button>
									</>
								) : (
									<>
										<span className="settings-badge" data-tone="ok">
											Connected
										</span>
										<button
											type="button"
											className="settings-secondary"
											onClick={() => setConfirmingSignOut(true)}
										>
											Sign out
										</button>
									</>
								)
							) : (
								<ChatgptSignIn
									label={
										account.status === "expired"
											? "Sign in again"
											: "Sign in with ChatGPT"
									}
									onConnected={() => void refreshAccount()}
									showHint={false}
								/>
							)}
						</div>
					</li>
					{xaiSubscription ? (
						<XaiSubscriptionRow
							subscription={xaiSubscription}
							onChange={() => void refreshAccount()}
						/>
					) : null}
				</ul>
				{signOut.error ? <p role="alert">{signOut.error.message}</p> : null}
			</section>
			<ClaudeSubscriptionSettings />
			<ModelConnections />
			<ModelFailoverSettings />
		</>
	);
}

/** Settings > Agents: the SuperGrok subscription, beside the Codex one. */
function XaiSubscriptionRow({
	subscription,
	onChange,
}: {
	subscription: XaiSubscriptionView;
	onChange: () => void;
}) {
	const disconnect = useServerFn(disconnectXaiSubscriptionFn);
	const [confirming, setConfirming] = useState(false);
	const signOut = useMutation({
		mutationFn: () => disconnect({ data: {} }),
		onSuccess: () => {
			setConfirming(false);
			onChange();
		},
	});
	const status = subscription.status;
	const meta =
		status === "disconnected"
			? "Use your SuperGrok or X subscription for Grok models."
			: status === "ready"
				? `${subscription.modelCount} Grok models`
				: xaiSubscriptionMessage(status);
	return (
		<li className="settings-row">
			<div className="settings-row-main">
				<span className="settings-row-icon">
					<GrokMark size={18} />
				</span>
				<div className="settings-row-text">
					<span className="settings-row-title">Grok subscription</span>
					<span
						className="settings-row-meta"
						title="Grok runs on your SuperGrok or X subscription, with no API bill. Usage counts against your plan's limits."
					>
						{meta}
					</span>
				</div>
			</div>
			<div className="settings-row-actions">
				{status === "ready" ? (
					confirming ? (
						<>
							<button
								type="button"
								className="settings-secondary"
								disabled={signOut.isPending}
								onClick={() => setConfirming(false)}
							>
								Cancel
							</button>
							<button
								type="button"
								className="settings-danger"
								disabled={signOut.isPending}
								onClick={() => signOut.mutate()}
							>
								{signOut.isPending ? "Signing out…" : "Sign out"}
							</button>
						</>
					) : (
						<>
							<span className="settings-badge" data-tone="ok">
								Connected
							</span>
							<button
								type="button"
								className="settings-secondary"
								onClick={() => setConfirming(true)}
							>
								Sign out
							</button>
						</>
					)
				) : (
					<XaiSubscriptionSignIn
						label={status === "disconnected" ? "Sign in with xAI" : "Reconnect"}
						onConnected={onChange}
					/>
				)}
			</div>
			{signOut.error ? <p role="alert">{signOut.error.message}</p> : null}
		</li>
	);
}

/** Secrets shared with every project; the agent saves one here when the user picks "all my projects". */
function AccountSecretsSection() {
	const listSecrets = useServerFn(listAccountSecretsFn);
	const deleteSecret = useServerFn(deleteAccountSecretFn);
	const [secrets, setSecrets] = useState<readonly PublicProjectSecret[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void listSecrets()
			.then(setSecrets)
			.catch(() => setSecrets([]));
	}, [listSecrets]);

	async function onDelete(secretId: string) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			setSecrets(await deleteSecret({ data: { secretId } }));
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not remove secret.",
			);
		} finally {
			setBusy(false);
		}
	}

	if (!secrets.length) return null;

	return (
		<section className="settings-section">
			<SettingsHeader
				title="Shared with all projects"
				description="Saved when you chose “all my projects”. A project's own secret of the same name wins."
			/>
			<ul className="settings-group">
				{secrets.map((secret) => (
					<li key={secret.id} className="settings-row">
						<div className="settings-row-text">
							<code className="settings-row-title">{secret.name}</code>
							<span className="settings-row-meta">
								{SECRET_KIND_LABELS[secret.kind]} · {secret.hint}
							</span>
						</div>
						<button
							type="button"
							className="settings-secondary"
							onClick={() => void onDelete(secret.id)}
							disabled={busy}
						>
							Remove
						</button>
					</li>
				))}
			</ul>
			{error ? <p role="alert">{error}</p> : null}
		</section>
	);
}
