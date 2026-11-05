import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { chatAddressInput, chatAddressOutput } from "./domain/chat-address";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const router = createTanStackRouter({
		routeTree,
		// A chat's address is /thread/<id>; the page reads it as /?chat=<id>.
		rewrite: { input: chatAddressInput, output: chatAddressOutput },
		scrollRestoration: true,
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
	});

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
