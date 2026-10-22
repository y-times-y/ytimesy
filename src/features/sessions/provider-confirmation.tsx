import { ArrowUpRight, Check } from "lucide-react";

/** OpenRouter owns this account confirmation; this action does not assert completion. */
export function ProviderConfirmation({
	author,
	connectionProvider,
}: {
	author: string | null;
	connectionProvider?: string;
}) {
	if (author !== "meta" || connectionProvider !== "openrouter") return null;
	return (
		<a
			className="model-provider-confirmation"
			href="https://openrouter.ai/settings/preferences"
			target="_blank"
			rel="noopener noreferrer"
			aria-label="Confirm age 18 or older on OpenRouter (opens in a new tab)"
		>
			<span className="model-confirmation-tick" aria-hidden="true">
				<Check size={12} strokeWidth={2} />
			</span>
			<span>
				<strong>Confirm 18+</strong>
				<small>For Muse Spark · once in OpenRouter</small>
			</span>
			<ArrowUpRight size={14} aria-hidden="true" />
		</a>
	);
}
