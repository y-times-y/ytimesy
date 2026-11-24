/**
 * The Cloudflare side as code: the edge executor and web Workers (with their
 * Durable Objects, Hyperdrive, VPC egress, service, email, AI and memory
 * bindings, crons, custom domain and secrets) for the `development` and
 * `production` stages, and the development realtime Worker.
 *
 * Code is built by the existing pipeline, not by Alchemy, and uploaded
 * byte-for-byte (`bundle: false`, Wrangler's no_bundle module rules):
 * - edge: `wrangler deploy --dry-run --outdir .ytimesy/edge-upload`, the exact
 *   files wrangler itself would upload (scripts/build-edge-executor.ts, then
 *   wrangler's bundling with quickjs.wasm as a compiled module);
 * - web: `vite build` (dist/server, whose generated wrangler.json is read
 *   here for the plain variables the build bakes in, and dist/client).
 *
 * Secrets come from the deploy script in a private file
 * (YTIMESY_INFRA_SECRETS_FILE, `{ edge: {...}, web: {...} }`), and go up with
 * the code as one version per Worker, as the wrangler deploy did. Secrets set
 * outside Alchemy are never deleted.
 *
 * Run only through scripts/infra.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { cloudflareStage, type InfraStage } from "./src/stages.ts";
import { stackState } from "./src/state.ts";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const path = (relative: string) => join(repository, relative);

const stage: InfraStage = cloudflareStage(process.env.ALCHEMY_STAGE);
const settings = {
	development: {
		edge: "ytimesy-edge-executor-development",
		web: "ytimesy-web-development",
		hyperdrive: "ytimesy-development-postgres",
		memory: "ytimesy-memory-development",
		edgeDomain: undefined,
		edgeWorkersDev: true,
	},
	production: {
		edge: "ytimesy-edge-executor-production",
		web: "ytimesy-web-production",
		hyperdrive: "ytimesy-production-postgres",
		memory: "ytimesy-memory-production",
		edgeDomain: "edge.ytimesy.com",
		edgeWorkersDev: false,
	},
}[stage];

/** The secrets for one Worker, as Cloudflare secret_text bindings. */
function secretsFor(worker: "edge" | "web"): Record<string, Redacted.Redacted<string>> {
	const file = process.env.YTIMESY_INFRA_SECRETS_FILE;
	if (!file) return {};
	const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string>>;
	return Object.fromEntries(
		Object.entries(all[worker] ?? {}).map(([name, value]) => [name, Redacted.make(value)]),
	);
}

/** The plain variables the web build baked into dist/server/wrangler.json. */
function webBuildVars(): Record<string, string> {
	const generated = path("dist/server/wrangler.json");
	if (!existsSync(generated)) throw new Error("Build the web first (vite build): dist/server/wrangler.json is missing.");
	const config = JSON.parse(readFileSync(generated, "utf8")) as {
		name: string;
		vars?: Record<string, unknown>;
	};
	if (config.name !== settings.web)
		throw new Error(`dist/server was built for ${config.name}, not ${settings.web} (set CLOUDFLARE_ENV for the build).`);
	return Object.fromEntries(Object.entries(config.vars ?? {}).map(([name, value]) => [name, String(value)]));
}

/** The edge entry wrangler's dry run wrote (refuses a missing or stale one). */
function edgeEntry(): string {
	const entry = path(".ytimesy/edge-upload/edge-executor.js");
	if (!existsSync(entry))
		throw new Error("Bundle the edge first: wrangler deploy --dry-run --outdir .ytimesy/edge-upload (scripts/infra.ts does).");
	return entry;
}

const compatibility = { date: "2026-10-08", flags: ["nodejs_compat"] };
const codexEgress = { type: "vpc_network", networkId: "cf1:network" } as const;

export default Alchemy.Stack(
	"ytimesy-cloudflare",
	{ providers: Cloudflare.providers(), state: stackState() },
	Effect.gen(function* () {
		// Created outside the stack (the origin password is write-only):
		// looked up by name, never created, updated or deleted.
		const hyperdrive = Cloudflare.Hyperdrive.Connection.lookup({ name: settings.hyperdrive });
		const memory = yield* Cloudflare.Artifacts.Namespace("Memory", { namespace: settings.memory });
		const email = yield* Cloudflare.Email.SendEmail("Email", {
			allowedSenderAddresses: ["noreply@ytimesy.com"],
		});

		const edge = yield* Cloudflare.Worker("Edge", {
			name: settings.edge,
			main: edgeEntry(),
			bundle: false,
			compatibility,
			observability: { enabled: true, traces: { enabled: true } },
			crons: ["* * * * *"],
			// A busy chat object moves to new code once idle, up to one step's
			// budget later (wrangler.edge-executor.jsonc).
			codeUpdateStrategy: { mode: "deferred", maxDelay: "15 minutes" },
			workersDev: settings.edgeWorkersDev,
			...(settings.edgeDomain ? { domain: settings.edgeDomain } : {}),
			env: {
				MODEL_CONVERSATIONS: Cloudflare.Workers.DurableObject("ModelConversation"),
				BACKGROUND_JOBS: Cloudflare.Workers.DurableObject("BackgroundJobRunner"),
				PROJECT_ENVIRONMENTS: Cloudflare.Workers.DurableObject("ProjectEnvironment"),
				USER_HUBS: Cloudflare.Workers.DurableObject("UserHub"),
				Y_SQUARED_CREWS: Cloudflare.Workers.DurableObject("YSquaredCrew"),
				HYPERDRIVE: hyperdrive,
				CODEX_EGRESS: codexEgress,
				EMAIL: email,
				ARTIFACTS: memory,
				AI: Cloudflare.Workers.AI(),
				...secretsFor("edge"),
			},
		}).pipe(RemovalPolicy.protect());

		const web = yield* Cloudflare.Worker("Web", {
			name: settings.web,
			main: path("dist/server/index.js"),
			bundle: false,
			assets: path("dist/client"),
			compatibility,
			observability: { enabled: true },
			placement: { mode: "smart" },
			// Not public until launch: no workers.dev URL and no preview URLs.
			// No `domain`: the public app route stays unmanaged here (the deploy
			// script's YTIMESY_GO_LIVE gate owns it), and omitting it never
			// detaches it.
			workersDev: false,
			env: {
				HYPERDRIVE: hyperdrive,
				CODEX_EGRESS: codexEgress,
				EMAIL: email,
				ARTIFACTS: memory,
				...webBuildVars(),
				...secretsFor("web"),
			},
		}).pipe(RemovalPolicy.protect());

		// Bind by the declared script name so Web can be read before Edge is
		// applied, without looking up a Worker already managed by this stack.
		yield* web.bind`EXECUTOR`({
			bindings: [{ type: "service", name: "EXECUTOR", service: settings.edge }],
		});

		if (stage === "development") {
			yield* Cloudflare.Worker("Realtime", {
				name: "ytimesy-realtime-development",
				main: path("src/realtime/worker.ts"),
				compatibility: { date: "2026-10-01" },
				observability: { enabled: true },
				workersDev: true,
				env: { CONVERSATIONS: Cloudflare.Workers.DurableObject("ConversationRoom") },
			}).pipe(RemovalPolicy.protect());
		}

		return { edge: edge.workerName, web: web.workerName };
	}),
);