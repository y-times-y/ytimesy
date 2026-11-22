import { createStart } from "@tanstack/react-start";
import { serverFnFetch } from "./features/app/server-fn-fetch";

/** TanStack Start's options (read by its plugin): see server-fn-fetch.ts. */
export const startInstance = createStart(() => ({
	serverFns: { fetch: serverFnFetch },
}));
