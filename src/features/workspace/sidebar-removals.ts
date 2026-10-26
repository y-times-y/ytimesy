import type { QueryClient } from "@tanstack/react-query";
import { cacheWrite, optimisticMutation } from "#/lib/optimistic-mutation";

type Listed = { readonly id: string };
type ChatInProject = { projectId: string; sessionId: string };

/** A deleted chat leaves the sidebar at once; a failed delete brings it back. */
export function chatRemoval(
	queryClient: QueryClient,
	remove: (input: { data: ChatInProject }) => Promise<unknown>,
) {
	return {
		mutationFn: (chat: ChatInProject) => remove({ data: chat }),
		...optimisticMutation<unknown, ChatInProject>({
			queryClient,
			scope: "sidebar-chats",
			writes: ({ projectId, sessionId }) => [
				cacheWrite<Listed[]>(["agent-sessions", projectId], (chats) =>
					chats.filter((chat) => chat.id !== sessionId),
				),
			],
			errorToast: "Couldn't delete the chat.",
		}),
	};
}

/** A removed project leaves the sidebar at once; a failed removal brings it back. */
export function projectRemoval(
	queryClient: QueryClient,
	remove: (input: { data: { projectId: string } }) => Promise<unknown>,
) {
	return {
		mutationFn: (projectId: string) => remove({ data: { projectId } }),
		...optimisticMutation<unknown, string>({
			queryClient,
			scope: "sidebar-projects",
			writes: (projectId) => [
				cacheWrite<Listed[]>(["projects"], (projects) =>
					projects.filter((project) => project.id !== projectId),
				),
			],
			errorToast: "Couldn't remove the project.",
		}),
	};
}
