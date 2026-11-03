import { Check, KeyRound } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { requestedSecrets } from "#/domain/secret-request";
import type { SecretRequestItem } from "#/domain/session-item";

export type SecretRequestActions = {
	readonly disabled: boolean;
	/** Saves one value to the project's secrets; it never enters the chat. */
	readonly onSave: (input: {
		readonly name: string;
		readonly value: string;
		readonly kind: "runtime" | "environment";
	}) => Promise<void>;
	/** Answers the card: the names saved and the names skipped. */
	readonly onAnswer: (
		saved: readonly string[],
		skipped: readonly string[],
	) => void;
};

/**
 * The agent asked for project secrets, in one card with a field each. Each
 * filled value is sent straight to project settings; an empty field is
 * skipped. The chat only records which names were saved and skipped.
 */
export function SecretRequestCard({
	item,
	outcome,
	actions,
}: {
	item: SecretRequestItem;
	outcome: "pending" | "provided" | "answered";
	actions?: SecretRequestActions;
}) {
	const secrets = requestedSecrets(item);
	const [values, setValues] = useState<Record<string, string>>({});
	// Saved before a failed save elsewhere in the card; not saved twice.
	const [saved, setSaved] = useState<readonly string[]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const formId = useId();
	const pending = outcome === "pending" && actions;
	const filled = secrets.filter(
		({ name }) => values[name] && !saved.includes(name),
	);
	const only = secrets.length === 1 ? secrets[0] : undefined;

	const skippedFrom = (done: readonly string[]) =>
		secrets.map(({ name }) => name).filter((name) => !done.includes(name));

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!actions || !filled.length || saving) return;
		setSaving(true);
		setError(null);
		const results = await Promise.allSettled(
			filled.map(({ name, secretKind }) =>
				actions.onSave({ name, value: values[name] ?? "", kind: secretKind }),
			),
		);
		const done = [
			...saved,
			...filled
				.filter((_, index) => results[index]?.status === "fulfilled")
				.map(({ name }) => name),
		];
		setSaved(done);
		setSaving(false);
		const failed = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failed) {
			setError(
				failed.reason instanceof Error
					? failed.reason.message
					: "Could not save the secret.",
			);
			return;
		}
		actions.onAnswer(done, skippedFrom(done));
	}

	return (
		<section
			className="plan-proposal"
			data-outcome={
				outcome === "provided" ? "approved" : pending ? "pending" : undefined
			}
			aria-label="Secrets requested"
		>
			<header className="plan-proposal-header">
				<KeyRound size={14} aria-hidden="true" />
				<strong>
					{only ? (
						<>
							The agent needs <code>{only.name}</code>
						</>
					) : (
						`The agent needs ${secrets.length} values`
					)}
				</strong>
				<span className="plan-proposal-status">
					{outcome === "provided" ? (
						<>
							<Check size={14} aria-hidden="true" /> Saved to project
						</>
					) : outcome === "answered" ? (
						"Answered"
					) : (
						"Waiting for you"
					)}
				</span>
			</header>
			{pending || !only ? (
				<ul className="secret-request-list">
					{secrets.map(({ name, reason }) => (
						<li key={name} className="secret-request-row">
							<div className="secret-request-label">
								<code>{name}</code>
								{reason ? <span title={reason}>{reason}</span> : null}
							</div>
							{pending ? (
								saved.includes(name) ? (
									<span className="secret-request-saved">
										<Check size={14} aria-hidden="true" /> Saved
									</span>
								) : (
									<input
										form={formId}
										className="secret-request-input"
										type="password"
										autoComplete="off"
										spellCheck={false}
										aria-label={`Value for ${name}`}
										placeholder={`Paste ${name}`}
										value={values[name] ?? ""}
										disabled={actions.disabled || saving}
										onChange={(event) =>
											setValues((current) => ({
												...current,
												[name]: event.target.value,
											}))
										}
									/>
								)
							) : null}
						</li>
					))}
				</ul>
			) : only.reason ? (
				<div className="plan-proposal-body">
					<p>{only.reason}</p>
				</div>
			) : null}
			{pending ? (
				<form id={formId} className="plan-proposal-actions" onSubmit={save}>
					<p className="secret-request-note">
						{error ??
							(secrets.some(({ secretKind }) => secretKind === "runtime")
								? "Saved encrypted to project settings. Empty fields are skipped."
								: "Saved to project settings, visible in output. Empty fields are skipped.")}
					</p>
					<button
						type="button"
						className="plan-proposal-revise"
						disabled={actions.disabled || saving}
						onClick={() => actions.onAnswer(saved, skippedFrom(saved))}
					>
						Skip for now
					</button>
					<button
						type="submit"
						className="plan-proposal-approve"
						disabled={actions.disabled || saving || !filled.length}
					>
						{saving ? "Saving…" : "Save"}
					</button>
				</form>
			) : null}
		</section>
	);
}
