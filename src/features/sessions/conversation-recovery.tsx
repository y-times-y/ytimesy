import type { QueryClient } from "@tanstack/react-query";
import { FileCode2, GitFork, History, Undo2, X } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useState } from "react";

/**
 * Restoring code changes the checkout under the Files and Changes views, which
 * otherwise keep showing files the restore removed until their next refresh.
 */
export function refreshRecoveredWorkspace(client: QueryClient) {
	return Promise.all(
		[
			"workspace-explorer",
			"workspace-changes",
			"workspace-preview-versions",
		].map((key) => client.invalidateQueries({ queryKey: [key] })),
	);
}

export function ConversationRecovery({
	codeAvailable,
	busy,
	onRecover,
}: {
	codeAvailable: boolean;
	busy: boolean;
	onRecover: (mode: "conversation" | "code" | "both" | "fork") => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	async function recover(mode: "code" | "both" | "fork") {
		setPending(true);
		setError("");
		try {
			// The caller refreshes Files and Changes as soon as the server is done.
			await onRecover(mode);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Recovery failed. Try again.",
			);
		} finally {
			setPending(false);
		}
	}
	const disabled = busy || pending;
	return (
		// Hidden until the message is hovered or focused (session-composer.css).
		// A failure stays shown (data-error) until dismissed or the next action.
		<div
			className="conversation-recovery"
			data-open={open || undefined}
			data-error={error ? true : undefined}
		>
			<DropdownMenu.Root open={open} onOpenChange={setOpen}>
				<DropdownMenu.Trigger asChild>
					<button
						type="button"
						className="conversation-recovery-trigger"
						disabled={disabled}
						aria-label="Restore or fork from here"
						title="Restore or fork from here"
					>
						<History size={14} aria-hidden="true" />
					</button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						className="recovery-menu"
						sideOffset={6}
						align="end"
						// Focus returning to the icon would keep it showing after the
						// pointer leaves; keyboard users reach it again with Tab.
						onCloseAutoFocus={(event) => event.preventDefault()}
					>
						<DropdownMenu.Label className="recovery-menu-label">
							From this message
						</DropdownMenu.Label>
						{codeAvailable ? (
							<>
								<DropdownMenu.Item
									disabled={disabled}
									onSelect={() => void recover("code")}
								>
									<FileCode2 size={16} aria-hidden="true" />
									Restore code
								</DropdownMenu.Item>
								<DropdownMenu.Item
									disabled={disabled}
									onSelect={() => void recover("both")}
								>
									<Undo2 size={16} aria-hidden="true" />
									Restore code and conversation
								</DropdownMenu.Item>
								<DropdownMenu.Separator />
							</>
						) : null}
						<DropdownMenu.Item
							disabled={disabled}
							onSelect={() => void recover("fork")}
						>
							<GitFork size={16} aria-hidden="true" />
							Fork conversation
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			{error ? (
				<RecoveryAlert message={error} onDismiss={() => setError("")} />
			) : null}
		</div>
	);
}

/** The recovery row's room under a message without a recovery point (yet). */
export function ConversationRecoverySlot() {
	return <div className="conversation-recovery" aria-hidden="true" />;
}

/** A recovery failure, kept until the user dismisses it or acts again. */
export function RecoveryAlert({
	message,
	onDismiss,
}: {
	message: string;
	onDismiss: () => void;
}) {
	return (
		<p className="conversation-recovery-error" role="alert">
			<span>{message}</span>
			<button
				type="button"
				className="conversation-recovery-dismiss"
				aria-label="Dismiss"
				title="Dismiss"
				onClick={onDismiss}
			>
				<X size={12} aria-hidden="true" />
			</button>
		</p>
	);
}
