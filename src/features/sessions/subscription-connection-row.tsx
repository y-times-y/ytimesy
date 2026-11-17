import { type ReactNode, useState } from "react";

/**
 * Settings > Agents: one plan/subscription connection (Codex, Claude, Grok).
 * Layout, status line, the badge + Sign out (with its confirm step) and the
 * error text live here; a provider only passes what differs.
 */
export type SubscriptionConnectionRowProps = {
	name: string;
	/** The provider's glyph, drawn at the same 18px for every provider. */
	mark: ReactNode;
	/** The one-line status under the name. */
	meta: string;
	/** Longer detail for the status line's tooltip. */
	metaTitle?: string;
	/** Extra text under the status line (e.g. a sign-in hint). */
	hint?: ReactNode;
	/** True while a sign-in exists (connected, limited or retrying): Sign out shows, sign-in does not. */
	signedIn: boolean;
	/** The badge beside Sign out; `ok` colors it as healthy. */
	badge: { text: string; ok?: boolean };
	/** The provider's sign-in action, shown while not signed in. */
	signIn: ReactNode;
	/** Signs out; the row closes its confirm step when it resolves. */
	onSignOut: () => Promise<unknown>;
};

export function SubscriptionConnectionRow({
	name,
	mark,
	meta,
	metaTitle,
	hint,
	signedIn,
	badge,
	signIn,
	onSignOut,
}: SubscriptionConnectionRowProps) {
	const [confirming, setConfirming] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const signOut = async () => {
		setPending(true);
		setError(null);
		try {
			await onSignOut();
			setConfirming(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not sign out.");
		} finally {
			setPending(false);
		}
	};
	return (
		<li className="settings-row" aria-label={name}>
			<div className="settings-row-main">
				<span className="settings-row-icon">{mark}</span>
				<div className="settings-row-text">
					<span className="settings-row-title">{name}</span>
					<span className="settings-row-meta" title={metaTitle}>
						{meta}
					</span>
					{/* Below the description, so the button column stays narrow. */}
					{signedIn ? null : hint}
				</div>
			</div>
			<div className="settings-row-actions">
				{signedIn ? (
					confirming ? (
						<>
							<button
								type="button"
								className="settings-secondary"
								disabled={pending}
								onClick={() => setConfirming(false)}
							>
								Cancel
							</button>
							<button
								type="button"
								className="settings-danger"
								disabled={pending}
								onClick={() => void signOut()}
							>
								{pending ? "Signing out…" : "Sign out"}
							</button>
						</>
					) : (
						<>
							<span
								className="settings-badge"
								data-tone={badge.ok ? "ok" : undefined}
							>
								{badge.text}
							</span>
							<button
								type="button"
								className="settings-secondary"
								onClick={() => setConfirming(true)}
							>
								Sign out
							</button>
						</>
					)
				) : (
					signIn
				)}
			</div>
			{error ? <p role="alert">{error}</p> : null}
		</li>
	);
}
