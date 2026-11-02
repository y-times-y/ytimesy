import type { ComposerSendBlock } from "#/domain/send-blocked";

/** Under the composer: why the send did not go, and the button that fixes it. */
export function SendBlockNotice({
	block,
	onFix,
}: {
	block: ComposerSendBlock;
	/** Absent where the fix cannot open (a Settings section from the side chat). */
	onFix?: (block: ComposerSendBlock) => void;
}) {
	return (
		<p className="session-attachment-error" role="alert">
			{block.message}
			{onFix ? (
				<>
					{" "}
					<button
						type="button"
						className="session-inline-action"
						onClick={() => onFix(block)}
					>
						{block.actionLabel}
					</button>
				</>
			) : null}
		</p>
	);
}
