import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Trash2 } from "lucide-react";
import { Fragment, useState } from "react";
import {
	cacheWrite,
	optimisticMutation,
	saveErrorMessage,
} from "#/lib/optimistic-mutation";
import type { PublicMcpServer } from "#/server/adapters/mcp-servers";
import { BrandLogo } from "./brand-logo";
import { IntegrationSwitch, StatusBadge } from "./integration-controls";
import { getMcpServersFn, startMcpOAuthFn } from "./mcp-servers.fn";
import { rememberMcpSignInReturn } from "./mcp-sign-in-return";
import {
	McpTokenPrompt,
	SIGN_IN_FAILED,
	signInOutcome,
	type TokenAsk,
} from "./mcp-token-prompt";
import {
	getPluginsFn,
	installPluginFn,
	setPluginEnabledFn,
	uninstallPluginFn,
} from "./plugins.fn";

type PluginsView = Awaited<ReturnType<typeof getPluginsFn>>;
type InstalledPlugins = PluginsView["installed"];
const PLUGINS_KEY = ["plugins"];
const SERVERS_KEY = ["mcp-servers"];

function installedSave<TVariables>(
	queryClient: QueryClient,
	writes: (variables: TVariables) => ReturnType<typeof cacheWrite>[],
) {
	return optimisticMutation<InstalledPlugins, TVariables>({
		queryClient,
		// Shared with MCP servers: a plugin's servers are in that list too.
		scope: "integrations",
		writes,
		invalidate: [SERVERS_KEY],
	});
}

const withInstalled = (
	update: (installed: InstalledPlugins) => InstalledPlugins,
) =>
	cacheWrite<PluginsView>(PLUGINS_KEY, (view) => ({
		...view,
		installed: update(view.installed),
	}));

/** A plugin's switch moves at once. */
export function pluginToggle(
	queryClient: QueryClient,
	toggle: (input: {
		data: { id: string; enabled: boolean };
	}) => Promise<InstalledPlugins>,
) {
	return {
		mutationFn: (input: { id: string; enabled: boolean }) =>
			toggle({ data: input }),
		...installedSave<{ id: string; enabled: boolean }>(
			queryClient,
			({ id, enabled }) => [
				withInstalled((installed) =>
					installed.map((row) => (row.id === id ? { ...row, enabled } : row)),
				),
			],
		),
	};
}

/** A removed plugin and its tool servers leave the lists at once. */
export function pluginUninstall(
	queryClient: QueryClient,
	uninstall: (input: { data: { id: string } }) => Promise<InstalledPlugins>,
) {
	return {
		mutationFn: (id: string) => uninstall({ data: { id } }),
		...installedSave<string>(queryClient, (id) => [
			withInstalled((installed) => installed.filter((row) => row.id !== id)),
			cacheWrite<PublicMcpServer[]>(SERVERS_KEY, (servers) =>
				servers.filter((server) => server.pluginId !== id),
			),
		]),
	};
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Plugins from our reviewed catalog; each bundles commands, skills and HTTP MCP servers. */
export function Plugins() {
	const queryClient = useQueryClient();
	const getPlugins = useServerFn(getPluginsFn);
	const install = useServerFn(installPluginFn);
	const toggle = useServerFn(setPluginEnabledFn);
	const uninstall = useServerFn(uninstallPluginFn);
	const getServers = useServerFn(getMcpServersFn);
	const startSignIn = useServerFn(startMcpOAuthFn);
	const plugins = useQuery({
		queryKey: PLUGINS_KEY,
		queryFn: () => getPlugins(),
	});
	// Shared with the MCP servers panel: which plugin servers still need sign-in.
	const servers = useQuery({
		queryKey: SERVERS_KEY,
		queryFn: () => getServers(),
	});
	const [config, setConfig] = useState<Record<string, Record<string, string>>>(
		{},
	);
	// A catalog plugin with settings opens them inline before installing.
	const [configuring, setConfiguring] = useState<string | null>(null);
	// A server that cannot sign the user in here asks for their token instead.
	const [ask, setAsk] = useState<TokenAsk | null>(null);
	const [signInFailed, setSignInFailed] = useState(false);
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ["plugins"] }),
			queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
		]);
	const signIn = useMutation({
		mutationFn: async (id: string) =>
			signInOutcome(id, await startSignIn({ data: { id } })),
		onMutate: () => setSignInFailed(false),
		onSuccess: (outcome, id) => {
			if ("go" in outcome) {
				rememberMcpSignInReturn("plugins", id);
				window.location.assign(outcome.go);
				return;
			}
			if ("ask" in outcome) setAsk(outcome.ask);
			if ("failed" in outcome) setSignInFailed(true);
			void refresh();
		},
	});
	const installMutation = useMutation({
		mutationFn: (catalogId: string) =>
			install({
				data: { catalogId, projectId: null, config: config[catalogId] ?? {} },
			}),
		onSuccess: () => {
			setConfiguring(null);
			void refresh();
		},
	});
	const toggleMutation = useMutation(pluginToggle(queryClient, toggle));
	const uninstallMutation = useMutation(
		pluginUninstall(queryClient, uninstall),
	);
	const busy = installMutation.isPending || signIn.isPending;
	const catalog = plugins.data?.catalog ?? [];
	const installed = plugins.data?.installed ?? [];
	const installedIds = new Set(installed.map((row) => row.catalogId));
	const available = catalog.filter((entry) => !installedIds.has(entry.id));
	const error =
		installMutation.error ??
		toggleMutation.error ??
		uninstallMutation.error ??
		signIn.error;
	return (
		<section className="integrations" aria-label="Plugins">
			<header className="integrations-head">
				<div>
					<h3>Plugins</h3>
					<p>
						Give the agent tools, commands and skills for the services you use.
					</p>
				</div>
				{plugins.data?.requestUrl ? (
					<a
						className="integrations-link"
						href={plugins.data.requestUrl}
						target="_blank"
						rel="noreferrer"
					>
						Request a plugin
					</a>
				) : null}
			</header>
			{error ? <p role="alert">{saveErrorMessage(error)}</p> : null}
			{signInFailed ? <p role="alert">{SIGN_IN_FAILED}</p> : null}
			{installed.length ? (
				<>
					<h4 className="integrations-label">Installed</h4>
					<ul className="integration-list">
						{installed.map((row) => {
							const entry = catalog.find((item) => item.id === row.catalogId);
							const oauth = (servers.data ?? []).filter(
								(server) =>
									server.pluginId === row.id && server.auth === "oauth",
							);
							const pending = oauth.filter(
								(server) => server.signIn === "needs-sign-in",
							);
							const needsToken = oauth.filter(
								(server) => server.signIn === "needs-token",
							);
							const asking =
								ask && oauth.some((server) => server.id === ask.id)
									? ask
									: null;
							const unreachable = oauth.filter(
								(server) => server.signIn === "unreachable",
							);
							const parts = [
								row.commands.length && count(row.commands.length, "command"),
								row.skills.length && count(row.skills.length, "skill"),
								row.mcpServers.length &&
									count(row.mcpServers.length, "tool server"),
							].filter(Boolean);
							return (
								<Fragment key={row.id}>
									<li className="integration-row">
										<BrandLogo id={row.catalogId} name={row.pluginName} />
										<div className="integration-main">
											<div className="integration-title">
												<strong>{entry?.displayName ?? row.pluginName}</strong>
											</div>
											<div className="integration-status">
												{!row.enabled ? (
													<StatusBadge tone="muted">Off</StatusBadge>
												) : servers.isPending ? (
													<StatusBadge tone="muted">Checking…</StatusBadge>
												) : needsToken.length ? (
													<StatusBadge tone="warning">
														Needs a token
													</StatusBadge>
												) : pending.length ? (
													<StatusBadge tone="warning">
														Needs sign-in
													</StatusBadge>
												) : unreachable.length ? (
													<StatusBadge tone="muted">
														Can't reach server
													</StatusBadge>
												) : oauth.length ? (
													<StatusBadge tone="success">Signed in</StatusBadge>
												) : (
													<StatusBadge tone="success">Ready</StatusBadge>
												)}
												<span className="integration-desc">
													{parts.join(" · ") || entry?.description}
												</span>
											</div>
										</div>
										<div className="integration-actions">
											{row.enabled
												? pending.map((server) => (
														<button
															type="button"
															className="integration-button-primary"
															key={server.id}
															disabled={busy}
															onClick={() => signIn.mutate(server.id)}
														>
															{signIn.isPending &&
															signIn.variables === server.id
																? "Opening…"
																: "Sign in"}
														</button>
													))
												: null}
											{row.enabled && !asking
												? needsToken.map((server) => (
														<button
															type="button"
															className="integration-button-primary"
															key={server.id}
															disabled={busy}
															onClick={() =>
																setAsk({ id: server.id, reason: "token" })
															}
														>
															Add token
														</button>
													))
												: null}
											<IntegrationSwitch
												label={`${row.pluginName} enabled`}
												checked={row.enabled}
												disabled={busy}
												onChange={(enabled) =>
													toggleMutation.mutate({ id: row.id, enabled })
												}
											/>
											<button
												type="button"
												className="integration-icon-button"
												aria-label="Remove"
												title="Remove"
												disabled={busy}
												onClick={() => uninstallMutation.mutate(row.id)}
											>
												<Trash2 size={16} />
											</button>
										</div>
									</li>
									{asking ? (
										<McpTokenPrompt
											ask={asking}
											onCancel={() => setAsk(null)}
											onSaved={(next) => {
												setAsk(null);
												queryClient.setQueryData(SERVERS_KEY, next);
												void refresh();
											}}
										/>
									) : null}
								</Fragment>
							);
						})}
					</ul>
				</>
			) : null}
			{available.length ? (
				<>
					<h4 className="integrations-label">Browse</h4>
					<div className="integration-grid">
						{available.map((entry) => {
							const open = configuring === entry.id;
							const installing =
								installMutation.isPending &&
								installMutation.variables === entry.id;
							return (
								<form
									className="integration-card"
									key={entry.id}
									onSubmit={(event) => {
										event.preventDefault();
										if (entry.settings.length && !open)
											setConfiguring(entry.id);
										else installMutation.mutate(entry.id);
									}}
								>
									<div className="integration-card-head">
										<BrandLogo id={entry.id} name={entry.displayName} />
										<strong>{entry.displayName}</strong>
									</div>
									<p className="integration-desc integration-clamp">
										{entry.description}
									</p>
									{open
										? entry.settings.map((setting) => (
												<label className="integration-field" key={setting.key}>
													<span>{setting.title}</span>
													<input
														type={setting.sensitive ? "password" : "text"}
														autoComplete="off"
														spellCheck={false}
														placeholder={setting.description}
														value={config[entry.id]?.[setting.key] ?? ""}
														onChange={(event) =>
															setConfig({
																...config,
																[entry.id]: {
																	...config[entry.id],
																	[setting.key]: event.target.value,
																},
															})
														}
													/>
												</label>
											))
										: null}
									<button
										type="submit"
										className="integration-button"
										disabled={busy}
									>
										{installing ? "Installing…" : "Install"}
									</button>
								</form>
							);
						})}
					</div>
				</>
			) : plugins.data && !installed.length ? (
				<p className="integration-desc">
					No reviewed plugins are available yet.
				</p>
			) : null}
		</section>
	);
}
