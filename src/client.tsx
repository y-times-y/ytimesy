import { RouterProvider } from "@tanstack/react-router";
import { hydrateStart } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { readyToHydrate } from "./features/app/hydration-ready";
import {
	recoverFromStaleChunks,
	watchForNewBuild,
} from "./features/app/new-build-reload";

// Before any route's code loads: a chunk the last deploy removed reloads the tab.
recoverFromStaleChunks();

// TanStack Start's own client entry, except that React hydrates once
// nothing in the server HTML would suspend (see readyToHydrate).
void hydrateStart().then(async (router) => {
	await readyToHydrate(router);
	startTransition(() => {
		hydrateRoot(
			document,
			<StrictMode>
				<RouterProvider router={router} />
			</StrictMode>,
		);
	});
	watchForNewBuild(router);
});
