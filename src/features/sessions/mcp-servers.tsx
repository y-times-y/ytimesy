import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { mcpServerLabel as serverLabel } from "#/domain/connector-name";
import { cacheWrite, optimisticMutation } from "#/lib/optimistic-mutation";
import type { PublicMcpServer } from "#/server/adapters/mcp-servers";
import { BrandLogo } from "./brand-logo";
import { IntegrationSwitch, StatusBadge } from "./integration-controls";
import {
	addMcpServerFn,
	getMcpServersFn,
	removeMcpServerFn,
	setMcpServerEnabledFn,
	startMcpOAuthFn,
} from "./mcp-servers.fn";
import { rememberMcpSignInReturn } from "./mcp-sign-in-return";

const SERVERS_KEY = ["mcp-servers"];

function mcpServersSave<TVariables>(
	queryClient: QueryClient,
	update: (
		servers: PublicMcpServer[],
		variables: TVariables,
	) => PublicMcpServer[],
) {
	return optimisticMutation<PublicMcpServer[], TVariables>({
		queryClient,
		scope: "integrations",
		writes: (variables) => [
			cacheWrite<PublicMcpServer[]>(SERVERS_KEY, (servers) =>
				update(servers, variables),
			),
		],
		serverWrites: (data) => [{ queryKey: SERVERS_KEY, data }],
	});
}

/** A server's switch moves at once; the server's checked list replaces it. */
export function mcpServerToggle(
	queryClient: QueryClient,
	toggle: (input: {
		data: { id: string; enabled: boolean };
	}) => Promise<PublicMcpServer[]>,
) {
	return {
		mutationFn: (input: { id: string; enabled: boolean }) =>
			toggle({ data: input }),
		...mcpServersSave<{ id: string; enabled: boolean }>(
			queryClient,
			(servers, { id, enabled }) =>
				servers.map((server) =>
					server.id === id ? { ...server, enabled } : server,
				),
		),
	};
}

/** A removed server leaves the list at once. */
export function mcpServerRemove(
	queryClient: QueryClient,
	remove: (input: { data: { id: string } }) => Promise<PublicMcpServer[]>,
) {
	return {
		mutationFn: (id: string) => remove({ data: { id } }),
		...mcpServersSave<string>(queryClient, (servers, id) =>
			servers.filter((server) => server.id !== id),
		),
	};
}

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
	const [adding, setAdding] = useState(false);
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [added, setAdded] = useState<number | null>(null);
	const update = (next: PublicMcpServer[]) =>
		queryClient.setQueryData(["mcp-servers"], next);
	// OAuth servers: the provider's sign-in page, then back to /api/mcp/oauth/callback.
	const signIn = useMutation({
		mutationFn: async (id: string) => ({
			id,
			...(await startSignIn({ data: { id } })),
		}),
		onSuccess: (result) => {
			if (result.url) {
				rememberMcpSignInReturn("mcp", result.id);
				window.location.assign(result.url);
			} else void servers.refetch();
		},
	});
	const add = useMutation({
		mutationFn: () =>
			addServer({
				data: {
					name,
					url,
					headers: apiKey
						? {
								Authorization: /^(Bearer|Basic) /i.test(apiKey)
									? apiKey
									: `Bearer ${apiKey}`,
							}
						: {},
					projectId: null,
				},
			}),
		onSuccess: (result) => {
			update(result.servers);
			setName("");
			setUrl("");
			setApiKey("");
			setAdding(false);
			if (result.signIn) signIn.mutate(result.signIn);
			else setAdded(result.toolCount);
		},
	});
	const toggle = useMutation(mcpServerToggle(queryClient, toggleServer));
	const remove = useMutation(mcpServerRemove(queryClient, deleteServer));
	const busy = add.isPending || signIn.isPending;
	const error = add.error ?? toggle.error ?? remove.error ?? signIn.error;
	return (
		<section className="integrations" aria-label="MCP servers">
			<header className="integrations-head">
				<div>
					<h3>MCP servers</h3>
					<p title="Credentials stay encrypted on our server and never enter the workspace.">
						Connect any remote MCP server.
					</p>
				</div>
				{!adding ? (
					<button
						type="button"
						className="integration-button"
						onClick={() => {
							setAdded(null);
							setAdding(true);
						}}
					>
						Add server
					</button>
				) : null}
			</header>
			{servers.isError ? <p role="alert">Could not load MCP servers.</p> : null}
			{error ? <p role="alert">{error.message}</p> : null}
			{added !== null ? (
				<p className="integration-desc">
					Connected · {added} tools available to the agent.
				</p>
			) : null}
			{adding ? (
				<form
					className="integration-card integration-add"
					onSubmit={(event) => {
						event.preventDefault();
						add.mutate();
					}}
				>
					<label className="integration-field">
						<span>Name</span>
						<input
							required
							pattern="[a-z0-9][a-z0-9_\-]{0,31}"
							title="Lowercase letters, numbers, - and _"
							value={name}
							placeholder="linear"
							onChange={(event) => setName(event.target.value.toLowerCase())}
						/>
					</label>
					<label className="integration-field">
						<span>Server URL</span>
						<input
							type="url"
							required
							pattern="https://.*"
							value={url}
							placeholder="https://mcp.example.com/mcp"
							onChange={(event) => setUrl(event.target.value)}
						/>
					</label>
					<label className="integration-field">
						<span>API key (optional)</span>
						<input
							type="password"
							autoComplete="off"
							spellCheck={false}
							value={apiKey}
							placeholder="Leave empty to sign in with your account"
							onChange={(event) => setApiKey(event.target.value)}
						/>
					</label>
					<div className="integration-actions">
						<button
							type="button"
							className="integration-button-quiet"
							onClick={() => setAdding(false)}
						>
							Cancel
						</button>
						<button
							type="submit"
							className="integration-button-primary"
							disabled={busy || !name || !url}
						>
							{add.isPending ? "Connecting…" : "Connect"}
						</button>
					</div>
				</form>
			) : null}
			{servers.data?.length ? (
				<ul className="integration-list">
					{servers.data.map((server) => {
						const needsSignIn = server.signIn === "needs-sign-in";
						return (
							<li className="integration-row" key={server.id}>
								<BrandLogo
									id={server.name}
									name={server.name}
									url={server.url}
								/>
								<div className="integration-main">
									<div className="integration-title">
										<strong>{serverLabel(server.name)}</strong>
									</div>
									<div className="integration-status">
										{!server.enabled ? (
											<StatusBadge tone="muted">Off</StatusBadge>
										) : needsSignIn ? (
											<StatusBadge tone="warning">Needs sign-in</StatusBadge>
										) : server.signIn === "unreachable" ? (
											<StatusBadge tone="muted">Can't reach server</StatusBadge>
										) : server.signIn === "signed-in" ? (
											<StatusBadge tone="success">Signed in</StatusBadge>
										) : (
											<StatusBadge tone="success">Connected</StatusBadge>
										)}
										<span className="integration-desc">
											{new URL(server.url).host}
										</span>
									</div>
								</div>
								<div className="integration-actions">
									{server.auth === "oauth" && server.enabled ? (
										<button
											type="button"
											className={
												needsSignIn
													? "integration-button-primary"
													: "integration-button-quiet"
											}
											disabled={busy}
											onClick={() => signIn.mutate(server.id)}
										>
											{signIn.isPending && signIn.variables === server.id
												? "Opening…"
												: needsSignIn
													? "Sign in"
													: "Reconnect"}
										</button>
									) : null}
									<IntegrationSwitch
										label={`${server.name} enabled`}
										checked={server.enabled}
										disabled={busy}
										onChange={(enabled) =>
											toggle.mutate({ id: server.id, enabled })
										}
									/>
									<button
										type="button"
										className="integration-icon-button"
										aria-label="Remove"
										title="Remove"
										disabled={busy}
										onClick={() => remove.mutate(server.id)}
									>
										<Trash2 size={16} />
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			) : servers.data && !adding ? (
				<p className="integration-desc">No MCP servers yet.</p>
			) : null}
		</section>
	);
}
