import { ClaudeSetupTokenSignIn } from "./claude-setup-token-sign-in";
import {
	claudeSubscriptionMeta,
	claudeSubscriptionUsable,
	useClaudeSubscription,
} from "./claude-subscription-settings";
import { ModelProviderLogo } from "./model-provider-logo";
import { SubscriptionConnectionRow } from "./subscription-connection-row";

/** Settings > Agents: the Claude plan, as a row beside Codex and Grok. */
export function ClaudeSubscriptionRow() {
	const { view, removing } = useClaudeSubscription();
	const data = view.data;
	if (!data?.enabled) return null;
	const meta = claudeSubscriptionMeta(data);
	return (
		<SubscriptionConnectionRow
			name="Claude subscription"
			mark={<ModelProviderLogo provider="anthropic" size={18} />}
			meta={meta.text}
			metaTitle={meta.tooltip}
			signedIn={claudeSubscriptionUsable(data)}
			badge={
				data.status === "connected"
					? { text: "Connected", ok: true }
					: { text: "Limited" }
			}
			signIn={<ClaudeSetupTokenSignIn />}
			onSignOut={() => removing.mutateAsync()}
		/>
	);
}
