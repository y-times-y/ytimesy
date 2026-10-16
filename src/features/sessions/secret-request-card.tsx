import { Check, KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { SecretRequestItem } from "#/domain/session-item";

export type SecretRequestActions = {
	readonly disabled: boolean;
	/** Saves the value to the project's secrets; it never enters the chat. */
	readonly onSave: (input: {
		readonly name: string;
		readonly value: string;
		readonly kind: SecretRequestItem["secretKind"];
	}) => Promise<void>;
	readonly onDecline: (name: string) => void;
};

/**
 * The agent asked for a project secret. The value is sent straight to project
 * settings; the chat only records that it was saved.
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
	const [value, setValue] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pending = outcome === "pending" && actions;

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!actions || !value || saving) return;
		setSaving(true);
		setError(null);
		try {
			await actions.onSave({ name: item.name, value, kind: item.secretKind });
			setValue("");
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not save the secret.",
			);
		} finally {
			setSaving(false);
		}
	}

	return (
		<section
			className="plan-proposal"
			data-outcome={
				outcome === "provided" ? "approved" : pending ? "pending" : undefined
			}
			aria-label="Secret requested"
		>
			<header className="plan-proposal-header">
				<KeyRound size={14} aria-hidden="true" />
				<strong>
					The agent needs <code>{item.name}</code>
				</strong>
				<span className="plan-proposal-status">
					{outcome === "provided" ? (
						<>
							<Check size={12} aria-hidden="true" /> Saved to project
						</>
					) : outcome === "answered" ? (
						"Answered"
					) : (
						"Waiting for you"
					)}
				</span>
			</header>
			{item.reason ? (
				<div className="plan-proposal-body">
					<p>{item.reason}</p>
				</div>
			) : null}
			{pending ? (
				<form className="plan-proposal-actions" onSubmit={save}>
					<input
						className="secret-request-input"
						type="password"
						autoComplete="off"
						spellCheck={false}
						aria-label={`Value for ${item.name}`}
						placeholder={`Paste ${item.name}`}
						value={value}
						disabled={actions.disabled || saving}
						onChange={(event) => setValue(event.target.value)}
					/>
					<button
						type="button"
						className="plan-proposal-revise"
						disabled={actions.disabled || saving}
						onClick={() => actions.onDecline(item.name)}
					>
						Skip
					</button>
					<button
						type="submit"
						className="plan-proposal-approve"
						disabled={actions.disabled || saving || !value}
					>
						{saving ? "Saving…" : "Save and continue"}
					</button>
					<p className="secret-request-note">
						{error ??
							(item.secretKind === "runtime"
								? "Saved encrypted to this project's secrets. The agent never sees the value; it is redacted from all output."
								: "Saved to this project's environment variables, visible in output.")}
					</p>
				</form>
			) : null}
		</section>
	);
}
