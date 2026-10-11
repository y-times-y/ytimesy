import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import type { PublicMcpServer } from "#/server/adapters/mcp-servers";
import {
	addMcpServerFn,
	getMcpServersFn,
	removeMcpServerFn,
	setMcpServerEnabledFn,
	startMcpOAuthFn,
} from "./mcp-servers.fn";

/** Remote MCP servers the agent can use; called from our server, keys never shown again. */
export function McpServers() {
	const queryClient = useQueryClient();
	const getServers = useServerFn(getMcpServersFn);
	const addServer = useServerFn(addMcpServerFn);
	const toggleServer = useServerFn(setMcpServerEnabledFn);
	const deleteServer = useServerFn(removeMcpServerFn);
	const startSignIn = useServerFn(startMcpOAuthFn);
	const servers = useQuery({
		queryKey: ["mcp-servers"],
		queryFn: () => getServers(),
	});
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [headerName, setHeaderName] = useState("Authorization");
	const [headerValue, setHeaderValue] = useState("");
	const [added, setAdded] = useState<number | null>(null);
	const update = (next: PublicMcpServer[]) =>
		queryClient.setQueryData(["mcp-servers"], next);
	const add = useMutation({
		mutationFn: () =>
			addServer({
				data: {
					name,
					url,
					headers: headerValue ? { [headerName]: headerValue } : {},
					projectId: null,
				},
			}),
		onSuccess: (result) => {
			update(result.servers);
			if (result.signIn) signIn.mutate(result.signIn);
			else setAdded(result.toolCount);
			setName("");
			setUrl("");
			setHeaderValue("");
		},
	});
	const toggle = useMutation({
		mutationFn: (input: { id: string; enabled: boolean }) =>
			toggleServer({ data: input }),
		onSuccess: update,
	});
	const remove = useMutation({
		mutationFn: (id: string) => deleteServer({ data: { id } }),
		onSuccess: update,
	});
	// OAuth servers: the provider's sign-in page, then back to /api/mcp/oauth/callback.
	const signIn = useMutation({
		mutationFn: (id: string) => startSignIn({ data: { id } }),
		onSuccess: (result) => {
			if (result.url) window.location.assign(result.url);
			else void servers.refetch();
		},
	});
	const busy =
		add.isPending || toggle.isPending || remove.isPending || signIn.isPending;
	return (
		<section aria-label="MCP servers">
			<h3>MCP servers</h3>
			<p className="settings-copy">
				Connect remote (HTTPS) MCP servers such as Linear, Sentry or your own
				API. Leave the header empty for servers that sign you in (OAuth). Our
				server calls them for the agent; credentials are encrypted, never shown
				again, and never enter the workspace.
			</p>
			{servers.isError ? (
				<p role="alert">
					Could not load MCP servers. Check the database migration.
				</p>
			) : null}
			{servers.data?.map((server) => (
				<div className="settings-card model-connection-card" key={server.id}>
					<strong>{server.name}</strong>
					<p className="settings-copy">
						{server.url}
						{server.headerNames.length
							? ` · headers: ${server.headerNames.join(", ")}`
							: ""}
						{server.pluginId ? ` · from plugin ${server.pluginId}` : ""}
						{server.auth === "oauth"
							? server.signedIn
								? " · signed in"
								: " · needs sign-in"
							: ""}
					</p>
					<p className="settings-copy">
						Tools appear to the agent as mcp__{server.name}__…
					</p>
					<div className="model-connection-actions">
						{server.auth === "oauth" ? (
							<button
								type="button"
								className="settings-secondary"
								disabled={busy}
								onClick={() => signIn.mutate(server.id)}
							>
								{server.signedIn ? "Sign in again" : "Sign in"}
							</button>
						) : null}
						<button
							type="button"
							className="settings-secondary"
							disabled={busy}
							onClick={() =>
								toggle.mutate({ id: server.id, enabled: !server.enabled })
							}
						>
							{server.enabled ? "Disable" : "Enable"}
						</button>
						<button
							type="button"
							className="settings-secondary"
							disabled={busy}
							onClick={() => remove.mutate(server.id)}
						>
							Remove
						</button>
					</div>
				</div>
			))}
			<form
				className="settings-secret-form model-connection-form"
				onSubmit={(event) => {
					event.preventDefault();
					setAdded(null);
					add.mutate();
				}}
			>
				<h4>Add MCP server</h4>
				<label htmlFor="mcp-name">Name</label>
				<input
					id="mcp-name"
					required
					pattern="[a-z0-9][a-z0-9_\-]{0,31}"
					title="Lowercase letters, numbers, - and _"
					value={name}
					placeholder="linear"
					onChange={(event) => setName(event.target.value.toLowerCase())}
				/>
				<label htmlFor="mcp-url">HTTPS URL</label>
				<input
					id="mcp-url"
					type="url"
					required
					pattern="https://.*"
					value={url}
					placeholder="https://mcp.example.com/mcp"
					onChange={(event) => setUrl(event.target.value)}
				/>
				<label htmlFor="mcp-header-name">Auth header (optional)</label>
				<input
					id="mcp-header-name"
					value={headerName}
					onChange={(event) => setHeaderName(event.target.value)}
				/>
				<input
					id="mcp-header-value"
					aria-label="Auth header value"
					type="password"
					autoComplete="off"
					spellCheck={false}
					value={headerValue}
					placeholder="Bearer …"
					onChange={(event) => setHeaderValue(event.target.value)}
				/>
				<button
					type="submit"
					className="settings-secondary"
					disabled={busy || !name || !url}
				>
					{add.isPending ? "Connecting…" : "Connect and save"}
				</button>
			</form>
			{added !== null ? (
				<p className="settings-copy">Connected · {added} tools available.</p>
			) : null}
			{add.error || toggle.error || remove.error || signIn.error ? (
				<p role="alert">
					{(add.error ?? toggle.error ?? remove.error ?? signIn.error)?.message}
				</p>
			) : null}
		</section>
	);
}
