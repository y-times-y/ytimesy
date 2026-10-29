import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Folder, MessageSquare } from "lucide-react";
import { useState } from "react";
import { type ArchivedItem, archiveDaysLeft } from "#/domain/archive";
import {
	deleteArchivedFn,
	listArchivedFn,
	restoreArchivedFn,
} from "../projects/project.fn";

const ARCHIVED_KEY = ["archived"] as const;

/** Settings > Archived: restore an archived chat or project, or delete it for good. */
export function ArchivedSettings() {
	const list = useServerFn(listArchivedFn);
	const archived = useQuery({ queryKey: ARCHIVED_KEY, queryFn: () => list() });
	return (
		<section className="settings-section">
			<header className="settings-section-head">
				<div>
					<h3>Archived</h3>
					<p title="Archived chats and projects are deleted for good after 30 days.">
						Restore within 30 days.
					</p>
				</div>
			</header>
			{archived.isPending ? (
				<p className="settings-copy">Loading…</p>
			) : archived.error ? (
				<p role="alert">{archived.error.message}</p>
			) : archived.data.length === 0 ? (
				<p className="settings-copy">Nothing archived.</p>
			) : (
				<ul className="settings-group">
					{archived.data.map((item) => (
						<ArchivedRow key={`${item.kind}:${item.id}`} item={item} />
					))}
				</ul>
			)}
		</section>
	);
}

function ArchivedRow({ item }: { item: ArchivedItem }) {
	const queryClient = useQueryClient();
	const restore = useServerFn(restoreArchivedFn);
	const remove = useServerFn(deleteArchivedFn);
	const [confirming, setConfirming] = useState(false);
	const done = async () => {
		await Promise.all(
			[ARCHIVED_KEY, ["projects"], ["agent-sessions"]].map((queryKey) =>
				queryClient.invalidateQueries({ queryKey }),
			),
		);
	};
	const input = { kind: item.kind, id: item.id, projectId: item.projectId };
	const restoring = useMutation({
		mutationFn: () => restore({ data: input }),
		onSuccess: done,
	});
	const deleting = useMutation({
		mutationFn: () => remove({ data: input }),
		onSuccess: done,
	});
	const busy = restoring.isPending || deleting.isPending;
	const days = archiveDaysLeft(item.archivedAt, Date.now());
	const Icon = item.kind === "project" ? Folder : MessageSquare;
	return (
		<li className="settings-row">
			<div className="settings-row-main">
				<span className="settings-row-icon">
					<Icon size={16} />
				</span>
				<div className="settings-row-text">
					<span className="settings-row-title">{item.title}</span>
					<span className="settings-row-meta">
						{item.kind === "project" ? "Project" : item.projectName}
						{" · "}
						{days === 0
							? "Deleted today"
							: `${days} ${days === 1 ? "day" : "days"} left`}
					</span>
				</div>
			</div>
			<div className="settings-row-actions">
				{confirming ? (
					<>
						<button
							type="button"
							className="settings-secondary"
							disabled={busy}
							onClick={() => setConfirming(false)}
						>
							Cancel
						</button>
						<button
							type="button"
							className="settings-danger"
							disabled={busy}
							onClick={() => deleting.mutate()}
						>
							{deleting.isPending ? "Deleting…" : "Delete for good"}
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							className="settings-secondary"
							disabled={busy}
							onClick={() => restoring.mutate()}
						>
							{restoring.isPending ? "Restoring…" : "Restore"}
						</button>
						<button
							type="button"
							className="settings-secondary"
							disabled={busy}
							onClick={() => setConfirming(true)}
						>
							Delete
						</button>
					</>
				)}
			</div>
			{restoring.error || deleting.error ? (
				<p role="alert" className="settings-row-meta">
					{(restoring.error ?? deleting.error)?.message}
				</p>
			) : null}
		</li>
	);
}
