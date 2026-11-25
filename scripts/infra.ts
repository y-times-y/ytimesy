/**
 * The only way to change infrastructure (infra/alchemy, Alchemy stacks):
 *
 *   node --import tsx scripts/infra.ts bootstrap-state cloudflare --stage development   # once per account
 *   node --import tsx scripts/infra.ts plan   cloudflare --stage development
 *   node --import tsx scripts/infra.ts deploy cloudflare --stage development
 *   node --import tsx scripts/infra.ts plan   aws        --stage production
 *   node --import tsx scripts/infra.ts deploy aws        --stage production --confirm-production
 *
 * Every deploy plans first and applies only a plan that removes, replaces,
 * orphans or unbinds nothing (scripts/infra-plan-guard.ts), on top of the
 * stacks' own RemovalPolicy.protect(). Taking over resources made before
 * the stacks existed needs --adopt-existing, once per stage. Production
 * needs --confirm-production and a checkout that contains origin/main.
 * Production web and edge code ships through deploy-production.ts, which
 * calls this with --prebuilt and its secrets file.
 *
 * Flags: --build (cloudflare: bundle the edge and build the web for the
 * stage first; deploy does it unless --prebuilt), --secrets-file PATH
 * (cloudflare: `{ edge: {...}, web: {...} }`), --plan-only-local (plan with
 * throwaway local state: reads only, never creates the shared state store).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { acquireDeployLock } from "./deploy-lock";
import { planProblems } from "./infra-plan-guard";
import {
	productionBuildSourceProblem,
	readBuildSource,
} from "./production-source";
import { liveWorkerBindingProblems } from "./worker-bindings-guard";

const STACKS = {
	aws: { file: "aws.run.ts", stages: ["production"] },
	cloudflare: {
		file: "cloudflare.run.ts",
		stages: ["development", "production"],
	},
} as const;
type StackName = keyof typeof STACKS;
type Stage = "development" | "production";

const [command, stackName, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(name);
const value = (name: string) => {
	const at = rest.indexOf(name);
	return at >= 0 ? rest[at + 1] : undefined;
};

if (command !== "plan" && command !== "deploy" && command !== "bootstrap-state")
	throw new Error(
		"Usage: scripts/infra.ts plan|deploy aws|cloudflare --stage development|production",
	);
if (!(stackName in STACKS))
	throw new Error(`Unknown stack ${stackName}; use aws or cloudflare.`);
const stack = STACKS[stackName as StackName];
const stage = value("--stage") as Stage | undefined;
if (!stage || !(stack.stages as readonly string[]).includes(stage))
	throw new Error(
		`--stage must be one of ${stack.stages.join(", ")} for ${stackName}.`,
	);
const adopting = flag("--adopt-existing");
const localState = flag("--plan-only-local");
if (command === "deploy" && localState)
	throw new Error(
		"--plan-only-local is for plans: a deploy must record its state in the shared store.",
	);

const directory = join(import.meta.dirname, "..", "infra", "alchemy");
// Alchemy's own entry under this Node (a .bin shim is a .cmd on Windows).
const alchemy = join(directory, "node_modules", "alchemy", "bin", "alchemy.js");
if (!existsSync(alchemy))
	throw new Error(
		"Install the infra package first: pnpm --dir infra/alchemy install --ignore-workspace --frozen-lockfile",
	);

if (stage === "production" && command === "deploy") {
	if (!flag("--confirm-production"))
		throw new Error(
			"A production infrastructure deploy needs --confirm-production.",
		);
	const problem = productionBuildSourceProblem(readBuildSource());
	if (problem) throw new Error(problem);
}

/** Credentials and settings for the stack, from what every chat receives. */
async function stackEnvironment(): Promise<Record<string, string>> {
	const env: Record<string, string> = {
		ALCHEMY_STAGE: stage as string,
		CI: "true",
		...(localState ? { YTIMESY_INFRA_STATE: "local" } : {}),
	};
	const token =
		process.env.CLOUDFLARE_DEPLOY_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
	if (!token)
		throw new Error(
			"CLOUDFLARE_DEPLOY_TOKEN is not set (the state store and the Cloudflare stack need it).",
		);
	const response = await fetch(
		"https://api.cloudflare.com/client/v4/accounts",
		{
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(20_000),
		},
	);
	const accounts =
		((await response.json()) as { result?: { id: string }[] }).result ?? [];
	if (accounts.length !== 1)
		throw new Error(
			`The deploy token sees ${accounts.length} Cloudflare accounts; expected exactly one.`,
		);
	env.CLOUDFLARE_API_TOKEN = token;
	env.CLOUDFLARE_ACCOUNT_ID = accounts[0].id;
	if (stackName === "aws") {
		if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
			throw new Error(
				"AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set.",
			);
		env.AWS_REGION = "us-east-1";
	}
	const secretsFile = value("--secrets-file");
	if (secretsFile) env.YTIMESY_INFRA_SECRETS_FILE = secretsFile;
	return env;
}

/** The edge upload and the web build the Cloudflare stack reads. */
function buildCloudflare() {
	const env = stage === "production" ? ["--env", "production"] : ["--env", ""];
	execFileSync(
		"pnpm",
		[
			"exec",
			"wrangler",
			"deploy",
			"--dry-run",
			"--outdir",
			".ytimesy/edge-upload",
			"--config",
			"wrangler.edge-executor.jsonc",
			...env,
		],
		{ stdio: "inherit" },
	);
	execFileSync("pnpm", ["exec", "vite", "build"], {
		stdio: "inherit",
		env: {
			...process.env,
			YTIMESY_TARGET: "cloudflare",
			...(stage === "production" ? { CLOUDFLARE_ENV: "production" } : {}),
		},
	});
}

/** Runs the Alchemy CLI; returns its output (also shown, secrets never are). */
function runAlchemy(
	action: "plan" | "deploy",
	env: Record<string, string>,
): string {
	const result = spawnSync(
		process.execPath,
		[
			alchemy,
			action,
			stack.file,
			"--stage",
			stage as string,
			"--no-input",
			// Approval is the guard above: deploy runs only after its plan passed.
			...(action === "deploy" ? ["--yes"] : []),
			...(adopting ? ["--adopt"] : []),
		],
		{
			cwd: directory,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			env: { ...process.env, ...env },
		},
	);
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	console.log(output);
	if (result.status !== 0)
		throw new Error(
			`alchemy ${action} ${stackName} (${stage}) failed; nothing more was applied.`,
		);
	return output;
}

if (
	stackName === "cloudflare" &&
	(flag("--build") || (command === "deploy" && !flag("--prebuilt")))
)
	buildCloudflare();

const env = await stackEnvironment();
if (command === "bootstrap-state") {
	// The shared Cloudflare state store (a Worker and a Secrets Store secret);
	// an existing store is adopted, never redeployed.
	const result = spawnSync(
		process.execPath,
		[alchemy, "state", "bootstrap", "--backend", "cloudflare", "--no-input"],
		{
			cwd: directory,
			encoding: "utf8",
			env: { ...process.env, ...env, CI: "" },
		},
	);
	console.log(`${result.stdout ?? ""}${result.stderr ?? ""}`);
	if (result.status !== 0) throw new Error("The state store bootstrap failed.");
	process.exit(0);
}
const release =
	command === "deploy"
		? acquireDeployLock(`infra-${stackName}-${stage}`)
		: () => {};
try {
	const plan = runAlchemy("plan", env);
	const problems = planProblems({ output: plan, stage, adopting });
	if (problems.length)
		throw new Error(
			`The ${stackName} plan for ${stage} is refused; nothing was applied:\n- ${problems.join("\n- ")}`,
		);
	if (command === "deploy") {
		runAlchemy("deploy", env);
		console.log(`Infrastructure ${stackName} deployed to ${stage}.`);
		// Alchemy cannot express every binding; prove the live Workers kept them.
		if (stackName.includes("cloudflare") && stage === "production") {
			const token =
				process.env.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_DEPLOY_TOKEN;
			const lost = token
				? await liveWorkerBindingProblems(token)
				: ["No Cloudflare token to check the live Worker bindings."];
			if (lost.length)
				throw new Error(
					`The deploy dropped required Worker bindings; redeploy through scripts/deploy-production-from-secret.ts or roll back:\n- ${lost.join("\n- ")}`,
				);
		}
	} else console.log(`Plan for ${stackName} (${stage}) passes the guard.`);
} finally {
	release();
}
