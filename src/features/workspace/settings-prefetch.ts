import type { QueryClient } from "@tanstack/react-query";
import { requestJson } from "../projects/api";
import { getClaudeSubscription } from "../sessions/claude-subscription.fn";
import { getModelConnections } from "../sessions/model-connections.fn";
import { getModelFailoverSettings } from "../sessions/model-failover.fn";
import { readMachineSizeFn } from "./machine-size.fn";
import { readMemoryModeFn } from "./memory.fn";
import { readNetworkAccessFn } from "./network-access.fn";
import {
	readProjectTrainingFn,
	readTrainingConsentFn,
} from "./training-consent.fn";

/**
 * Settings' saved values, read ahead (when the app is idle, and again when
 * Settings opens): a section shows its switches and choices as saved the
 * moment it is picked, never a default that flips a second later. Data read
 * in the last minute is not read again.
 */
export function prefetchSettings(queryClient: QueryClient, projectId?: string) {
	const reads: [readonly unknown[], () => Promise<unknown>][] = [
		[["account"], () => requestJson("/api/account")],
		[["training-consent"], () => readTrainingConsentFn()],
		[["memory-mode"], () => readMemoryModeFn()],
		[["model-connections"], () => getModelConnections()],
		[["model-failover-settings"], () => getModelFailoverSettings()],
		[["claude-subscription"], () => getClaudeSubscription()],
	];
	if (projectId) {
		const data = { projectId };
		reads.push(
			[["project-machine-size", projectId], () => readMachineSizeFn({ data })],
			[
				["project-network-access", projectId],
				() => readNetworkAccessFn({ data }),
			],
			[["project-training", projectId], () => readProjectTrainingFn({ data })],
		);
	}
	for (const [queryKey, queryFn] of reads)
		void queryClient
			.prefetchQuery({ queryKey, queryFn, staleTime: 60_000 })
			.catch(() => undefined);
}
