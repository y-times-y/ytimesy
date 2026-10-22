import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronUp } from "lucide-react";
import "./model-connections.css";
import { IntegrationSwitch } from "./integration-controls";
import {
	getModelFailoverSettings,
	type ModelFailoverSettings as Settings,
	saveModelFailoverSettingsFn,
} from "./model-failover.fn";

const KIND_LABELS = {
	subscription: "Subscription",
	key: "API key",
	gateway: "Gateway",
	custom: "Custom endpoint",
} as const;

/**
 * When a model's connection is down, a turn continues on the next one: the
 * same model on another connection first, then the closest comparable model.
 * The user ranks their connections and decides whether a paid key needs
 * their go-ahead.
 */
export function ModelFailoverSettings() {
	const queryClient = useQueryClient();
	const getSettings = useServerFn(getModelFailoverSettings);
	const saveSettings = useServerFn(saveModelFailoverSettingsFn);
	const settings = useQuery({
		queryKey: ["model-failover-settings"],
		queryFn: () => getSettings(),
	});
	const save = useMutation({
		mutationFn: (next: Settings) =>
			saveSettings({
				data: {
					enabled: next.enabled,
					askBeforePaid: next.askBeforePaid,
					connectionOrder: next.connections.map((row) => row.key),
				},
			}),
		onMutate: (next) => {
			queryClient.setQueryData(["model-failover-settings"], next);
		},
		onSuccess: (saved) => {
			queryClient.setQueryData(["model-failover-settings"], saved);
		},
		onError: () => {
			void settings.refetch();
		},
	});
	const current = settings.data;
	function move(index: number, offset: -1 | 1) {
		if (!current) return;
		const connections = [...current.connections];
		const [row] = connections.splice(index, 1);
		connections.splice(index + offset, 0, row);
		save.mutate({ ...current, connections });
	}
	return (
		<section
			aria-label="Automatic failover"
			className="settings-section settings-section-gap"
		>
			<header className="settings-section-head">
				<div>
					<h3>Automatic failover</h3>
					<p title="If a provider has an outage, is overloaded, rate limited or out of plan usage, the turn continues on your next connection: the same model first, then the closest comparable one. Your next message tries your chosen model again.">
						Keep a turn going when its provider fails.
					</p>
				</div>
			</header>
			{settings.isError ? (
				<p role="alert">Could not load failover settings. Please retry.</p>
			) : null}
			{current ? (
				<>
					<ul className="settings-group">
						<li className="settings-row">
							<div className="settings-row-text">
								<span className="settings-row-title">
									Switch automatically during outages
								</span>
								<span className="settings-row-meta">
									Off keeps every turn on the model you chose.
								</span>
							</div>
							<div className="settings-row-actions">
								<IntegrationSwitch
									label="Switch automatically during outages"
									checked={current.enabled}
									disabled={save.isPending}
									onChange={(enabled) => save.mutate({ ...current, enabled })}
								/>
							</div>
						</li>
						<li className="settings-row">
							<div className="settings-row-text">
								<span className="settings-row-title">
									Ask before using a paid key
								</span>
								<span className="settings-row-meta">
									Stop and ask before moving from a subscription to an API key.
								</span>
							</div>
							<div className="settings-row-actions">
								<IntegrationSwitch
									label="Ask before using a paid key"
									checked={current.askBeforePaid}
									disabled={save.isPending || !current.enabled}
									onChange={(askBeforePaid) =>
										save.mutate({ ...current, askBeforePaid })
									}
								/>
							</div>
						</li>
					</ul>
					{current.connections.length > 1 ? (
						<ol
							className="settings-group model-failover-order"
							aria-label="Failover order"
						>
							{current.connections.map((connection, index) => (
								<li key={connection.key} className="settings-row">
									<div className="settings-row-text">
										<span className="settings-row-title">
											{index + 1}. {connection.label}
										</span>
										<span className="settings-row-meta">
											{KIND_LABELS[connection.kind]}
										</span>
									</div>
									<div className="settings-row-actions">
										<button
											type="button"
											className="settings-secondary model-failover-move"
											aria-label={`Move ${connection.label} up`}
											disabled={save.isPending || index === 0}
											onClick={() => move(index, -1)}
										>
											<ChevronUp size={14} aria-hidden="true" />
										</button>
										<button
											type="button"
											className="settings-secondary model-failover-move"
											aria-label={`Move ${connection.label} down`}
											disabled={
												save.isPending ||
												index === current.connections.length - 1
											}
											onClick={() => move(index, 1)}
										>
											<ChevronDown size={14} aria-hidden="true" />
										</button>
									</div>
								</li>
							))}
						</ol>
					) : null}
				</>
			) : null}
			{save.error ? (
				<p role="alert">Could not save failover settings. Please retry.</p>
			) : null}
		</section>
	);
}
