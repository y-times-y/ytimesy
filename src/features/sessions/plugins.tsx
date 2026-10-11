import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getMcpServersFn, startMcpOAuthFn } from "./mcp-servers.fn";
import {
	getPluginsFn,
	installPluginFn,
	setPluginEnabledFn,
	uninstallPluginFn,
} from "./plugins.fn";

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
		queryKey: ["plugins"],
		queryFn: () => getPlugins(),
	});
	// Shared with the MCP servers panel: which plugin servers still need sign-in.
	const servers = useQuery({
		queryKey: ["mcp-servers"],
		queryFn: () => getServers(),
	});
	const [config, setConfig] = useState<Record<string, Record<string, string>>>(
		{},
	);
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ["plugins"] }),
			queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
		]);
	const signIn = useMutation({
		mutationFn: (id: string) => startSignIn({ data: { id } }),
		onSuccess: (result) => {
			if (result.url) window.location.assign(result.url);
			else void refresh();
		},
	});
	const installMutation = useMutation({
		mutationFn: (catalogId: string) =>
			install({
				data: { catalogId, projectId: null, config: config[catalogId] ?? {} },
			}),
		onSuccess: refresh,
	});
	const toggleMutation = useMutation({
		mutationFn: (input: { id: string; enabled: boolean }) =>
			toggle({ data: input }),
		onSuccess: refresh,
	});
	const uninstallMutation = useMutation({
		mutationFn: (id: string) => uninstall({ data: { id } }),
		onSuccess: refresh,
	});
	const busy =
		installMutation.isPending ||
		toggleMutation.isPending ||
		uninstallMutation.isPending ||
		signIn.isPending;
	const installedIds = new Set(
		plugins.data?.installed.map((row) => row.catalogId),
	);
	return (
		<section aria-label="Plugins">
			<h3>Plugins</h3>
			<p className="settings-copy">
				Plugins bundle commands, skills and remote MCP servers. Only plugins we
				have reviewed can be installed, each pinned to the reviewed version.
				{plugins.data?.requestUrl ? (
					<>
						{" "}
						<a href={plugins.data.requestUrl} target="_blank" rel="noreferrer">
							Request a plugin
						</a>
					</>
				) : null}
			</p>
			{plugins.data?.installed.map((row) => (
				<div className="settings-card model-connection-card" key={row.id}>
					<strong>{row.pluginName}</strong>
					<p className="settings-copy">
						Commands:{" "}
						{row.commands
							.map((name) => `/${row.pluginName}:${name}`)
							.join(", ") || "none"}
						{" · "}Skills: {row.skills.join(", ") || "none"}
						{" · "}MCP: {row.mcpServers.join(", ") || "none"}
					</p>
					{row.unsupported.length ? (
						<p className="settings-copy">
							Not available in the cloud: {row.unsupported.join("; ")}
						</p>
					) : null}
					<div className="model-connection-actions">
						{servers.data
							?.filter(
								(server) =>
									server.pluginId === row.id &&
									server.auth === "oauth" &&
									!server.signedIn,
							)
							.map((server) => (
								<button
									type="button"
									className="settings-primary"
									key={server.id}
									disabled={busy}
									onClick={() => signIn.mutate(server.id)}
								>
									Sign in to {server.name}
								</button>
							))}
						<button
							type="button"
							className="settings-secondary"
							disabled={busy}
							onClick={() =>
								toggleMutation.mutate({ id: row.id, enabled: !row.enabled })
							}
						>
							{row.enabled ? "Disable" : "Enable"}
						</button>
						<button
							type="button"
							className="settings-secondary"
							disabled={busy}
							onClick={() => uninstallMutation.mutate(row.id)}
						>
							Uninstall
						</button>
					</div>
				</div>
			))}
			{plugins.data && plugins.data.catalog.length === 0 ? (
				<p className="settings-copy">No reviewed plugins are available yet.</p>
			) : null}
			{plugins.data?.catalog
				.filter((entry) => !installedIds.has(entry.id))
				.map((entry) => (
					<form
						className="settings-secret-form model-connection-form"
						key={entry.id}
						onSubmit={(event) => {
							event.preventDefault();
							installMutation.mutate(entry.id);
						}}
					>
						<h4>{entry.displayName}</h4>
						<p className="settings-copy">{entry.description}</p>
						{entry.settings.map((setting) => (
							<div key={setting.key}>
								<label htmlFor={`plugin-${entry.id}-${setting.key}`}>
									{setting.title}
								</label>
								<input
									id={`plugin-${entry.id}-${setting.key}`}
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
							</div>
						))}
						<button
							type="submit"
							className="settings-secondary"
							disabled={busy}
						>
							{installMutation.isPending &&
							installMutation.variables === entry.id
								? "Installing…"
								: "Install"}
						</button>
					</form>
				))}
			{installMutation.error ||
			toggleMutation.error ||
			uninstallMutation.error ? (
				<p role="alert">
					{
						(
							installMutation.error ??
							toggleMutation.error ??
							uninstallMutation.error
						)?.message
					}
				</p>
			) : null}
		</section>
	);
}
