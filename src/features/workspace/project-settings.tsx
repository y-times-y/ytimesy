import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bot, Folder, User, X } from "lucide-react";
import { ScrollArea } from "radix-ui";
import { type FormEvent, useEffect, useState } from "react";
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
import { McpServers } from "../sessions/mcp-servers";
import { ModelConnections } from "../sessions/model-connections";
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

	return (
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
										{currentProject ? (
											<MachineSizeSettings
												key={currentProject.id}
												projectId={currentProject.id}
											/>
										) : null}
										<ProjectSecretsSection project={currentProject} />
									</>
								) : null}
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
		</div>
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
		<>
			<h3>Account</h3>
			<p className="settings-copy">Signed in to ytimesy.</p>
			<div className="settings-card settings-identity">
				{user?.image ? (
					<img src={user.image} width={40} height={40} alt="" />
				) : (
					<span className="settings-initials" aria-hidden="true">
						{accountInitials(user ?? {})}
					</span>
				)}
				<div>
					<strong>{accountDisplayName(user ?? {})}</strong>
					{user?.email ? <p>{user.email}</p> : null}
				</div>
			</div>
			<button type="button" className="settings-secondary" onClick={onSignOut}>
				Sign out
			</button>
		</>
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
	const disconnect = useMutation({
		mutationFn: () =>
			requestJson<{ connected: boolean }>("/api/github/disconnect", {}),
		onSuccess: () => window.location.assign("/"),
	});
	if (loading) return <p className="settings-copy">Loading GitHub…</p>;
	return (
		<>
			<h3>GitHub</h3>
			<p className="settings-copy">{githubConnectionCopy(connected)}</p>
			{projects.length ? (
				<ul className="settings-project-list">
					{projects.map((project) => (
						<li key={project.id}>
							<strong>{projectDisplayName(project)}</strong>
							<span>
								{project.fullName} · {project.branch}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p className="settings-copy">No projects yet.</p>
			)}
			<AddProjectForm variant="settings" onAdded={onProjectAdded} />
			{connected ? (
				<button
					type="button"
					className="settings-secondary"
					disabled={disconnect.isPending}
					onClick={() => disconnect.mutate()}
				>
					{disconnect.isPending ? "Disconnecting…" : "Disconnect GitHub"}
				</button>
			) : null}
			{disconnect.error ? <p role="alert">{disconnect.error.message}</p> : null}
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
			<>
				<h3>Project</h3>
				<p className="settings-copy">Add a project first.</p>
			</>
		);
	}

	return (
		<>
			<h3>{projectDisplayName(project)}</h3>
			<p className="settings-copy">
				{project.fullName} on {project.branch}. Secrets become environment
				variables for the agent. The browser only sees names and hints.
			</p>
			<ul className="settings-secret-list">
				{secrets.length === 0 ? (
					<li className="settings-copy">No secrets yet.</li>
				) : (
					secrets.map((secret) => (
						<li key={secret.id}>
							<span>
								<code>{secret.name}</code>
								<span className="settings-secret-hint">{secret.hint}</span>
							</span>
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
				className="settings-secret-form"
				onSubmit={(event) => void onSave(event)}
			>
				<label htmlFor="project-secret-name">Name</label>
				<input
					id="project-secret-name"
					autoComplete="off"
					spellCheck={false}
					placeholder="NAME"
					value={name}
					onChange={(event) => setName(event.target.value.toUpperCase())}
				/>
				<label htmlFor="project-secret-value">Value</label>
				<input
					id="project-secret-value"
					type="password"
					autoComplete="off"
					spellCheck={false}
					placeholder="Value"
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
				<button type="submit" disabled={busy || !name.trim() || !value.trim()}>
					{busy ? "Saving…" : "Add secret"}
				</button>
			</form>
			{error ? <p role="alert">{error}</p> : null}
		</>
	);
}

function AgentsSection({
	account,
	usage,
}: {
	account: UserAgentAccount;
	usage?: CodexUsage;
}) {
	return (
		<>
			<h3>Agents</h3>
			<p className="settings-copy">
				Existing runtime sign-in stays in the composer. Manage model API
				connections below.
			</p>
			<ul className="settings-harness-list">
				{offeredAgentProviders().map((provider) => (
					<li key={provider.id}>
						<strong>{provider.name}</strong>
						<span>{harnessSettingsCopy({ id: provider.id, account })}</span>
					</li>
				))}
			</ul>
			<ModelConnections />
			<McpServers />
			<CodexSubscriptionUsage usage={usage} />
		</>
	);
}

import type { CodexUsage } from "#/domain/codex-usage";
import { CodexSubscriptionUsage } from "../sessions/codex-usage";
