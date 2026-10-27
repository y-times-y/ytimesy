import { RotateCw } from "lucide-react";
import { Button } from "#/components/ui/button";

/** A panel's one recovery action (try again, reconnect, restart); spins while busy. */
export function RetryButton({
	label,
	busy = false,
	onClick,
}: {
	label: string;
	busy?: boolean;
	onClick: () => void;
}) {
	return (
		<Button
			type="button"
			variant="outline"
			size="lg"
			className="retry-button"
			disabled={busy}
			aria-busy={busy || undefined}
			onClick={onClick}
		>
			<RotateCw
				data-icon="inline-start"
				className="motion-safe:group-aria-busy/button:animate-spin"
				aria-hidden
			/>
			{label}
		</Button>
	);
}
