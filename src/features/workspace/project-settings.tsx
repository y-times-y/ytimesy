import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Blocks, Bot, Folder, Plug, User, X } from "lucide-react";
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
import { offeredAgentProviders } from "#/domain/agent-provider";
import type { PublicProjectSecret } from "#/domain/project-secret";
import { type Project, projectDisplayName } from "#/domain/projects";
import type { UserAgentAccount } from "#/domain/user-agent-account";
import {
	accountDisplayName,
	accountInitials,
	githubConnectionCopy,
	harnessSettingsCopy,
	type SettingsSection,
	settingsNavItems,
} from "#/domain/workspace-settings";
import { AddProjectForm } from "../projects/add-project-form";
import { requestJson } from "../projects/api";
import { AgentProviderMark } from "../sessions/agent-provider-mark";
import { McpServers } from "../sessions/mcp-servers";
import { ModelConnections } from "../sessions/model-connections";
import { getModelConnections } from "../sessions/model-connections.fn";
import { Plugins } from "../sessions/plugins";
import { GithubMark } from "./github-mark";
import { InfrastructureUsage } from "./infrastructure-usage";
import { MachineSizeSettings } from "./machine-size-settings";
import {
	deleteProjectSecretFn,
	listProjectSecretsFn,
	saveProjectSecretFn,
} from "./project-secrets.fn";
import { codexSubscriptionUsageFn } from "./subscription-usage.fn";

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
	github: GithubMark,
	project: Folder,
	agents: Bot,
	plugins: Blocks,
	mcp: Plug,
} as const;

export function ProjectSettings({
	codexUsage,
	open,
	projectId,
	projects,
	selectedProject,
	onProjectAdded,
	onSignOut,
	onClose,
}: {
	open: boolean;
	codexUsage?: CodexUsage;
	projectId?: string;
	projects: readonly Project[];
	selectedProject?: Project;
	onProjectAdded: (project: Project) => void;
	onSignOut: () => void;
	onClose: () => void;
}) {
	const [section, setSection] = useState<SettingsSection>("account");
	const [settingsProjectId, setSettingsProjectId] = useState<string>();
	const readSubscriptionUsage = useServerFn(codexSubscriptionUsageFn);
	const subscriptionUsage = useQuery({
		queryKey: ["codex-subscription-usage"],
		queryFn: () => readSubscriptionUsage(),
		enabled: open && section === "agents",
		staleTime: 30_000,
		refetchInterval: open && section === "agents" ? 60_000 : false,
		retry: false,
	});
	const account = useQuery({
		queryKey: ["account"],
		queryFn: () => requestJson<AccountView>("/api/account"),
		enabled: open,
	});

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
									<Icon size={15} strokeWidth={1.5} />
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
										<ProjectSecretsSection project={settingsProject} />
									</>
								) : null}
								{section === "plugins" ? <Plugins /> : null}
								{section === "mcp" ? <McpServers /> : null}
								{section === "agents" ? (
									<AgentsSection
										usage={subscriptionUsage.data ?? codexUsage}
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
	action,
}: {
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<header className="settings-section-head">
			<div>
				<h3>{title}</h3>
				{description ? <p>{description}</p> : null}
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
		</section>
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
							) : null}
						</div>
					</div>
				</div>
				{disconnect.error ? (
					<p role="alert">{disconnect.error.message}</p>
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
										<Folder size={15} strokeWidth={1.5} />
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
						<li className="settings-empty">No repositories yet.</li>
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

function ProjectSecretsSection({ project }: { project?: Project }) {
	const listSecrets = useServerFn(listProjectSecretsFn);
	const saveSecret = useServerFn(saveProjectSecretFn);
	const deleteSecret = useServerFn(deleteProjectSecretFn);
	const [secrets, setSecrets] = useState<readonly PublicProjectSecret[]>([]);
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
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
					data: { projectId: project.id, name, value },
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

	async function onDelete(secretId: string) {
		if (!project || busy) return;
		setBusy(true);
		setError(null);
		try {
			setSecrets(
				await deleteSecret({
					data: { projectId: project.id, secretId },
				}),
			);
		} catch (cause) {
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
				title="Environment secrets"
				description="Available to the agent as environment variables in this project. Values are encrypted and never shown again; the browser only sees names and hints."
			/>
			<ul className="settings-group">
				{secrets.length === 0 ? (
					<li className="settings-empty">No secrets yet.</li>
				) : (
					secrets.map((secret) => (
						<li key={secret.id} className="settings-row">
							<div className="settings-row-text">
								<code className="settings-row-title">{secret.name}</code>
								<span className="settings-row-meta">{secret.hint}</span>
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

function AgentsSection({
	account,
	usage,
}: {
	account: UserAgentAccount;
	usage?: CodexUsage;
}) {
	const readConnections = useServerFn(getModelConnections);
	const connections = useQuery({
		queryKey: ["model-connections"],
		queryFn: () => readConnections(),
	});
	const apiKeyCount = connections.data?.length ?? 0;
	return (
		<>
			<section className="settings-section">
				<SettingsHeader
					title="Coding agents"
					description="Sign in to an agent from the agent picker in the composer."
				/>
				<ul className="settings-group">
					{offeredAgentProviders().map((provider) => {
						const connected =
							provider.id === "codex"
								? account.status === "connected"
								: provider.id === "api"
									? apiKeyCount > 0
									: false;
						return (
							<li key={provider.id} className="settings-row">
								<div className="settings-row-main">
									<span className="settings-row-icon">
										<AgentProviderMark provider={provider.id} size={16} />
									</span>
									<div className="settings-row-text">
										<span className="settings-row-title">{provider.name}</span>
										<span className="settings-row-meta">
											{provider.id === "api"
												? apiKeyCount > 0
													? `${apiKeyCount} API ${apiKeyCount === 1 ? "key" : "keys"} saved below.`
													: "Add an API key below to use your own model account."
												: harnessSettingsCopy({ id: provider.id, account })}
										</span>
									</div>
								</div>
								<span
									className="settings-badge"
									data-tone={connected ? "ok" : undefined}
								>
									{connected ? "Connected" : "Not connected"}
								</span>
							</li>
						);
					})}
				</ul>
				<CodexSubscriptionUsage usage={usage} />
			</section>
			<ModelConnections />
		</>
	);
}

import type { CodexUsage } from "#/domain/codex-usage";
import { CodexSubscriptionUsage } from "../sessions/codex-usage";
