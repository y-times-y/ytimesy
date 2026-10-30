import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	Archive,
	Blocks,
	BookMarked,
	Bot,
	Folder,
	Plug,
	Shield,
	User,
	X,
} from "lucide-react";
import { ScrollArea } from "radix-ui";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
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
import type { UserAgentAccount } from "#/domain/user-agent-account";
import {
	accountDisplayName,
	accountInitials,
	githubConnectionCopy,
	type SettingsSection,
	settingsNavItems,
} from "#/domain/workspace-settings";
import { authClient } from "../auth/client";
import { AddProjectForm } from "../projects/add-project-form";
import { requestJson } from "../projects/api";
import { clearChatCache } from "../sessions/chat-cache";
import { ChatgptSignIn } from "../sessions/chatgpt-sign-in";
import { CodexMark } from "../sessions/codex-mark";
import { CodexSubscriptionUsage } from "../sessions/codex-usage";
import { McpServers } from "../sessions/mcp-servers";
import { ModelConnections } from "../sessions/model-connections";
import { getModelConnections } from "../sessions/model-connections.fn";
import { getModelFailoverSettings } from "../sessions/model-failover.fn";
import { ModelFailoverSettings } from "../sessions/model-failover-settings";
import { Plugins } from "../sessions/plugins";
import { ArchivedSettings } from "./archived-settings";
import { GithubMark } from "./github-mark";
import { InfrastructureUsage } from "./infrastructure-usage";
import { readMachineSizeFn } from "./machine-size.fn";
import { MachineSizeSettings } from "./machine-size-settings";
import { MemorySettings } from "./memory-settings";
import { readNetworkAccessFn } from "./network-access.fn";
import { NetworkAccessSettings } from "./network-access-settings";
import {
	deleteProjectSecretFn,
	listProjectSecretsFn,
	saveProjectSecretFn,
} from "./project-secrets.fn";
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
	};
	readonly githubConnected: boolean;
	readonly agentAccount: UserAgentAccount;
};

const sectionIcon = {
	account: User,
	privacy: Shield,
	memory: BookMarked,
	github: GithubMark,
	project: Folder,
	agents: Bot,
	plugins: Blocks,
	mcp: Plug,
	archived: Archive,
} as const;

export function ProjectSettings({
	open,
	projectId,
	projects,
	selectedProject,
	onProjectAdded,
	onSignOut,
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
	onClose: () => void;
}) {
	const [section, setSection] = useState<SettingsSection>("account");
	useEffect(() => {
		if (open && initialSection) setSection(initialSection);
	}, [open, initialSection]);
	const [settingsProjectId, setSettingsProjectId] = useState<string>();
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
	});
	// The sections' own reads start with the panel: a section picked later
	// shows at its full height instead of growing as its data lands.
	const queryClient = useQueryClient();
	const prefetchProjectId =
		settingsProjectId ?? selectedProject?.id ?? projectId;
	useEffect(() => {
		if (!open) return;
		void queryClient.prefetchQuery({
			queryKey: ["model-connections"],
			queryFn: () => getModelConnections(),
		});
		void queryClient.prefetchQuery({
			queryKey: ["model-failover-settings"],
			queryFn: () => getModelFailoverSettings(),
		});
		if (!prefetchProjectId) return;
		const data = { projectId: prefetchProjectId };
		void queryClient.prefetchQuery({
			queryKey: ["project-machine-size", prefetchProjectId],
			queryFn: () => readMachineSizeFn({ data }),
		});
		void queryClient.prefetchQuery({
			queryKey: ["project-network-access", prefetchProjectId],
			queryFn: () => readNetworkAccessFn({ data }),
		});
	}, [open, prefetchProjectId, queryClient]);

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
									<>
										<AccountSection
											loading={account.isPending}
											error={account.error?.message}
											user={user}
											onSignOut={onSignOut}
										/>
										<InfrastructureUsage />
									</>
								) : null}
								{section === "privacy" ? <TrainingConsentSettings /> : null}
								{section === "memory" ? <MemorySettings /> : null}
								{section === "archived" ? <ArchivedSettings /> : null}
								{section === "github" ? (
									<GithubSection
										loading={account.isPending}
										connected={githubConnected}
										projects={projects}
										onProjectAdded={onProjectAdded}
									/>
								) : null}
								{section === "project" ? (
									<>
										{settingsProject ? (
											<ProjectHeader
												project={settingsProject}
												projects={projects}
												onSelect={setSettingsProjectId}
											/>
										) : null}
										{settingsProject ? (
											<MachineSizeSettings
												key={settingsProject.id}
												projectId={settingsProject.id}
											/>
										) : null}
										{settingsProject ? (
											<NetworkAccessSettings
												key={`network-${settingsProject.id}`}
												projectId={settingsProject.id}
											/>
										) : null}
										<ProjectSecretsSection project={settingsProject} />
										{settingsProject ? (
											<ProjectTrainingSettings
												key={`training-${settingsProject.id}`}
												projectId={settingsProject.id}
											/>
										) : null}
									</>
								) : null}
								{section === "plugins" ? <Plugins /> : null}
								{section === "mcp" ? <McpServers /> : null}
								{section === "agents" ? (
									<AgentsSection
										account={
											account.data?.agentAccount ?? { status: "disconnected" }
										}
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

function ProjectHeader({
	project,
	projects,
	onSelect,
}: {
	project: Project;
	projects: readonly Project[];
	onSelect: (projectId: string) => void;
}) {
	return (
		<SettingsHeader
			title={projectDisplayName(project)}
			description={`${project.fullName} · ${project.branch}`}
			action={
				projects.length > 1 ? (
					<Select value={project.id} onValueChange={onSelect}>
						<SelectTrigger
							className="settings-project-select"
							aria-label="Project"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{projects.map((row) => (
								<SelectItem key={row.id} value={row.id}>
									{projectDisplayName(row)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : undefined
			}
		/>
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
	onSignOut,
}: {
	loading: boolean;
	error?: string;
	user?: AccountView["user"];
	onSignOut: () => void;
}) {
	if (loading) return <p className="settings-copy">Loading account…</p>;
	if (error) return <p role="alert">{error}</p>;
	return (
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
			<DeleteAccount email={user?.email} />
		</section>
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
					description="ytimesy clones and pushes only the repositories you grant its GitHub App."
				/>
				<div className="settings-group">
					<div className="settings-row">
						<div className="settings-row-main">
							<span className="settings-row-icon">
								<GithubMark size={16} />
							</span>
							<div className="settings-row-text">
								<span className="settings-row-title">GitHub</span>
								<span className="settings-row-meta">
									{connected
										? "Repositories you granted can be added below."
										: githubConnectionCopy(false)}
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

	if (!project) {
		return (
			<SettingsHeader
				title="Project"
				description="Add a repository first; project settings appear here."
			/>
		);
	}

	return (
		<section className="settings-section settings-section-gap">
			<SettingsHeader
				title="Secrets"
				description="Encrypted and never shown again."
				details="Environment variables and runtime secrets are loaded as environment variables for the agent and services. Runtime secret values (and common encodings of them) are redacted from what the model and this chat see on a best-effort basis, and commits containing them are refused. Build secrets are only passed to environment setup."
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
					<Select
						value={kind}
						disabled={busy}
						onValueChange={(next) => setKind(next as ProjectSecretKind)}
					>
						<SelectTrigger aria-label="Secret type">
							<SelectValue>{SECRET_KIND_LABELS[kind]}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{(
								Object.entries(SECRET_KIND_LABELS) as [
									ProjectSecretKind,
									string,
								][]
							).map(([id, label]) => (
								<SelectItem
									key={id}
									value={id}
									textValue={label}
									title={SECRET_KIND_HINTS[id]}
								>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
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
						{busy ? "Saving…" : "Add secret"}
					</button>
				</div>
			</form>
			{error ? <p role="alert">{error}</p> : null}
		</section>
	);
}

function AgentsSection({ account }: { account: UserAgentAccount }) {
	const queryClient = useQueryClient();
	const [confirmingSignOut, setConfirmingSignOut] = useState(false);
	const refreshAccount = () =>
		Promise.all(
			[["account"], ["codex-subscription-usage"], ["agent-model-catalog"]].map(
				(queryKey) => queryClient.invalidateQueries({ queryKey }),
			),
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
					description="Your Codex subscription or your API keys."
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
								/>
							)}
						</div>
					</li>
				</ul>
				{signOut.error ? <p role="alert">{signOut.error.message}</p> : null}
				{connected ? <CodexSubscriptionUsage /> : null}
			</section>
			<ModelConnections />
			<ModelFailoverSettings />
		</>
	);
}
