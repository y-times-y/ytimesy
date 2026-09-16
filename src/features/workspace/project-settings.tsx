import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useEffect, useState } from "react";
import type { PublicProjectSecret } from "#/domain/project-secret";
import {
	deleteProjectSecretFn,
	listProjectSecretsFn,
	saveProjectSecretFn,
} from "./project-secrets.fn";

export function ProjectSettings({
	open,
	projectId,
	onClose,
}: {
	open: boolean;
	projectId?: string;
	onClose: () => void;
}) {
	const listSecrets = useServerFn(listProjectSecretsFn);
	const saveSecret = useServerFn(saveProjectSecretFn);
	const deleteSecret = useServerFn(deleteProjectSecretFn);
	const [secrets, setSecrets] = useState<readonly PublicProjectSecret[]>([]);
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!open || !projectId) {
			setSecrets([]);
			return;
		}
		void listSecrets({ data: { projectId } })
			.then(setSecrets)
			.catch((cause: unknown) => {
				setError(
					cause instanceof Error ? cause.message : "Could not load secrets.",
				);
			});
	}, [listSecrets, open, projectId]);

	if (!open) return null;

	async function onSave(event: FormEvent) {
		event.preventDefault();
		if (!projectId || busy) return;
		setBusy(true);
		setError(null);
		try {
			setSecrets(
				await saveSecret({
					data: { projectId, name, value },
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
		if (!projectId || busy) return;
		setBusy(true);
		setError(null);
		try {
			setSecrets(
				await deleteSecret({
					data: { projectId, secretId },
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

	return (
		<div className="settings-overlay">
			<button
				type="button"
				className="settings-backdrop"
				aria-label="Close settings"
				onClick={onClose}
			/>
			<section className="settings-panel" aria-label="Settings">
				<div className="settings-panel-head">
					<h2>Settings</h2>
					<button type="button" className="panel-toggle" onClick={onClose}>
						Close
					</button>
				</div>
				<p className="settings-copy">
					Secrets are exported as environment variables for the agent. The
					browser only sees names and hints. Values are never shown again.
				</p>
				{!projectId ? (
					<p className="settings-copy">Select a project first.</p>
				) : (
					<>
						<ul className="settings-secret-list">
							{secrets.length === 0 ? (
								<li className="settings-copy">No secrets yet.</li>
							) : (
								secrets.map((secret) => (
									<li key={secret.id}>
										<span>
											<code>{secret.name}</code>
											<span className="settings-secret-hint">
												{secret.hint}
											</span>
										</span>
										<button
											type="button"
											className="panel-toggle"
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
							<label className="sr-only" htmlFor="project-secret-name">
								Secret name
							</label>
							<input
								id="project-secret-name"
								autoComplete="off"
								spellCheck={false}
								placeholder="NAME"
								value={name}
								onChange={(event) => setName(event.target.value.toUpperCase())}
							/>
							<label className="sr-only" htmlFor="project-secret-value">
								Secret value
							</label>
							<input
								id="project-secret-value"
								type="password"
								autoComplete="off"
								spellCheck={false}
								placeholder="Value"
								value={value}
								onChange={(event) => setValue(event.target.value)}
							/>
							<button
								type="submit"
								disabled={busy || !name.trim() || !value.trim()}
							>
								{busy ? "Saving…" : "Add secret"}
							</button>
						</form>
					</>
				)}
				{error ? <p role="alert">{error}</p> : null}
			</section>
		</div>
	);
}
