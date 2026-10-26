import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ExternalLink, RefreshCw } from "lucide-react";
import { publicFailureMessage } from "#/domain/project-workspace";
import {
	getWorkspacePreviews,
	openWorkspacePreviewFn,
	setWorkspacePreviewSharingFn,
} from "./preview.fn";
import "./preview-inspector.css";

/**
 * Apps listening in the chat's machine. Opening one publishes it privately
 * (only this signed-in browser gets in); sharing adds a public link.
 */
export function PreviewInspector({
	projectId,
	sessionId,
	active,
}: {
	projectId?: string;
	sessionId?: string;
	active: boolean;
}) {
	const loadPreviews = useServerFn(getWorkspacePreviews);
	const openPreview = useServerFn(openWorkspacePreviewFn);
	const setSharing = useServerFn(setWorkspacePreviewSharingFn);
	const queryClient = useQueryClient();
	const queryKey = ["workspace-previews", projectId, sessionId];
	const previews = useQuery({
		queryKey,
		queryFn: () =>
			loadPreviews({
				data: { projectId: projectId ?? "", sessionId: sessionId ?? "" },
			}),
		enabled: active && Boolean(projectId && sessionId),
		// Listing runs a command in the VM, which counts as activity and would
		// keep an idle machine awake; refresh is manual.
		refetchOnWindowFocus: false,
	});
	const open = useMutation({
		mutationFn: async (port: number) => {
			// Opened before the await so the browser treats it as the click's popup.
			const tab = window.open("about:blank", "_blank");
			try {
				const { url } = await openPreview({
					data: {
						projectId: projectId ?? "",
						sessionId: sessionId ?? "",
						port,
					},
				});
				if (tab) {
					tab.opener = null;
					tab.location.href = url;
				} else window.location.assign(url);
			} catch (error) {
				tab?.close();
				throw error;
			}
		},
	});
	const share = useMutation({
		mutationFn: (input: { port: number; shared: boolean }) =>
			setSharing({
				data: {
					projectId: projectId ?? "",
					sessionId: sessionId ?? "",
					...input,
				},
			}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey }),
	});

	if (!projectId || !sessionId)
		return (
			<section className="inspector-empty" data-kind="preview">
				<h2>Preview</h2>
				<p>Open a chat to preview the apps running in its workspace.</p>
			</section>
		);
	const data = previews.data;
	if (data?.status !== "ready")
		return (
			<section className="inspector-empty" data-kind="preview">
				<h2>Preview</h2>
				<p>
					{previews.isLoading
						? "Looking for running apps…"
						: data?.status === "unavailable"
							? data.reason
							: data?.status === "asleep"
								? "This chat's machine is asleep. Start the app from the chat or terminal, then check again."
								: previews.error
									? publicFailureMessage(previews.error)
									: "No running apps yet."}
				</p>
			</section>
		);
	const failure = open.error ?? share.error;
	return (
		<section className="preview-inspector" aria-label="App previews">
			<header className="preview-toolbar">
				<span>
					Previews are private to you. Sharing gives anyone with the link
					access.
				</span>
				<button
					type="button"
					aria-label="Refresh ports"
					onClick={() => previews.refetch()}
				>
					<RefreshCw size={14} />
				</button>
			</header>
			{failure ? (
				<p className="preview-error">{publicFailureMessage(failure)}</p>
			) : null}
			{data.ports.length === 0 ? (
				<p className="preview-muted">
					No app is listening yet. Start a dev server (for example on port 3000)
					bound to 0.0.0.0.
				</p>
			) : (
				<ul className="preview-ports">
					{data.ports.map((entry) => (
						<li key={entry.port}>
							<div className="preview-port">
								<strong>Port {entry.port}</strong>
								{entry.loopbackOnly ? (
									<span className="preview-muted">
										Listening on localhost only; bind it to 0.0.0.0 to preview.
									</span>
								) : null}
								{entry.shareUrl ? (
									<a href={entry.shareUrl} target="_blank" rel="noreferrer">
										{entry.shareUrl}
									</a>
								) : null}
							</div>
							<label className="preview-share">
								<input
									type="checkbox"
									// The link comes from the server; until then the box shows the choice.
									checked={
										share.isPending && share.variables.port === entry.port
											? share.variables.shared
											: entry.shareUrl !== null
									}
									disabled={share.isPending}
									onChange={(event) =>
										share.mutate({
											port: entry.port,
											shared: event.target.checked,
										})
									}
								/>
								Share
							</label>
							<button
								type="button"
								disabled={open.isPending}
								onClick={() => open.mutate(entry.port)}
							>
								<ExternalLink size={14} />
								Open
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
