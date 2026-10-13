/** Bindings of the web app's Worker; absent when it runs on the local Node dev server. */
export interface WebWorkerEnvironment {
	HYPERDRIVE: Hyperdrive;
	/** VPC egress that ChatGPT subscription endpoints accept (plain Worker fetches get 403). */
	CODEX_EGRESS: Fetcher;
	/** The edge executor Worker, reached directly instead of over its public URL. */
	EXECUTOR: Fetcher;
}
