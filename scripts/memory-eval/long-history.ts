// Long-history memory fixtures for memory-long-history-eval.ts: a seeded
// history of ~150 memory lines (superseded decisions, expired entries,
// near-duplicates, distractors), update chats where the user changes or adds
// decisions in passing, probe chats whose deterministic verifier checks one
// fact each, and freshness pairs (an update immediately followed by a probe
// that depends on it). `solutions` let --dry-run prove each verifier passes
// the current fact and fails the stale one (and the untouched fixture).

export type HistoryLine = {
	file: string;
	text: string;
	/** YYYY-MM-DD the line was (notionally) saved. */
	added: string;
	expires?: string;
	/** What the line is for in this eval (never shown to either arm). */
	role:
		| "superseded"
		| "latest"
		| "expired"
		| "old-valid"
		| "near-duplicate"
		| "distractor";
};

const line = (
	file: string,
	added: string,
	text: string,
	role: HistoryLine["role"] = "distractor",
	expires?: string,
): HistoryLine => ({ file, added, text, role, expires });

/**
 * The seeded history. Superseded lines stay where they were written (the
 * save hook only appends; dreaming only edits what new chats touch), and the
 * newer line comes later in the same file, as an append would put it.
 */
export const HISTORY: HistoryLine[] = [
	// MEMORY.md: what every chat needs.
	line(
		"MEMORY.md",
		"2026-01-05",
		"Prefers short, direct replies; no long preambles",
	),
	line(
		"MEMORY.md",
		"2026-01-05",
		"Main stack: Python 3.12 services plus Node 22 tooling, in one monorepo",
	),
	line(
		"MEMORY.md",
		"2026-01-09",
		"Always run the tests before saying a change is done",
	),
	line(
		"MEMORY.md",
		"2026-01-05",
		"The main branch is main; never force-push it",
	),
	line("MEMORY.md", "2026-02-11", "Ask before deleting files outside the task"),
	line(
		"MEMORY.md",
		"2026-03-02",
		"Answer in English even when code comments are in German",
	),

	// tooling.md: npm -> pnpm -> pnpm except legacy/ (the exception probe).
	line("tooling.md", "2026-02-03", "Use npm for installs", "superseded"),
	line("tooling.md", "2026-02-03", "Node version is pinned to 22 in .nvmrc"),
	line(
		"tooling.md",
		"2026-01-15",
		"Python code is formatted with Black",
		"superseded",
	),
	line(
		"tooling.md",
		"2026-02-06",
		"CLI scripts live in scripts/ and use argparse",
		"superseded",
	),
	line(
		"tooling.md",
		"2026-02-20",
		"Prettier formats JS with tabs and double quotes",
	),
	line(
		"tooling.md",
		"2026-03-01",
		"Makefile targets: make test, make lint, make dev",
	),
	line(
		"tooling.md",
		"2026-03-18",
		"Ruff is the Python linter; run `ruff check .` before committing",
	),
	line(
		"tooling.md",
		"2026-04-02",
		"Pre-commit hooks are optional; don't add new ones",
	),
	line(
		"tooling.md",
		"2026-04-22",
		"Replaced Black with `ruff format` for Python formatting",
	),
	line(
		"tooling.md",
		"2026-05-05",
		"Prefers ripgrep over grep in docs examples",
	),
	line(
		"tooling.md",
		"2026-05-12",
		"Switched the repo from npm to pnpm; use pnpm for installs",
		"superseded",
	),
	line(
		"tooling.md",
		"2026-06-01",
		"Install packages with pnpm, not npm",
		"near-duplicate",
	),
	line("tooling.md", "2026-06-14", "Use uv to manage Python virtualenvs"),
	line(
		"tooling.md",
		"2026-07-21",
		"pnpm everywhere, except legacy/, which still uses npm (its CI image has no pnpm): install there with npm so legacy/package-lock.json stays the lockfile",
		"latest",
	),
	line(
		"tooling.md",
		"2026-08-02",
		"Docker images are built with `docker buildx bake`",
	),

	// testing.md: Jest -> Vitest (-> node:test in an update chat).
	line("testing.md", "2026-01-20", "JS tests use Jest", "superseded"),
	line(
		"testing.md",
		"2026-01-20",
		"Python tests use pytest with plain asserts, no unittest classes",
	),
	line(
		"testing.md",
		"2026-02-25",
		"Integration tests need `docker compose up db` first",
	),
	line("testing.md", "2026-03-12", "Coverage threshold is 80% for services/"),
	line(
		"testing.md",
		"2026-04-14",
		"Use factory functions in tests/factories.py instead of fixtures for model objects",
	),
	line(
		"testing.md",
		"2026-05-19",
		"Snapshot tests are discouraged; assert on specific fields",
	),
	line(
		"testing.md",
		"2026-06-02",
		"Moved from Jest to Vitest for all JS tests",
		"superseded",
	),
	line(
		"testing.md",
		"2026-07-02",
		"JS unit tests run with Vitest",
		"near-duplicate",
	),
	line(
		"testing.md",
		"2026-07-07",
		"Flaky test test_retry_backoff is quarantined with @pytest.mark.flaky",
	),

	// api.md: error shape and timestamps (both changed again in update chats).
	line(
		"api.md",
		"2026-01-28",
		"API timestamps are unix seconds (int)",
		"superseded",
	),
	line(
		"api.md",
		"2026-02-15",
		'API errors return {"error": "<message>"}',
		"superseded",
	),
	line("api.md", "2026-02-15", "Never return stack traces in API errors"),
	line(
		"api.md",
		"2026-03-06",
		"HTTP routes are mounted under /api/v2 (e.g. /api/v2/orders)",
		"old-valid",
	),
	line(
		"api.md",
		"2026-03-20",
		"Pagination uses cursor + limit query params, max limit 100",
	),
	line("api.md", "2026-03-20", "Every endpoint is documented in docs/api.md"),
	line(
		"api.md",
		"2026-04-09",
		"API timestamps: switched from unix seconds to ISO 8601 UTC strings ending in Z",
		"superseded",
	),
	line(
		"api.md",
		"2026-05-02",
		"Request IDs come in the X-Request-Id header and are echoed back",
	),
	line(
		"api.md",
		"2026-06-20",
		'API errors now return {"error": {"code": "<snake_case_code>", "message": "<text>"}} with the HTTP status',
		"superseded",
	),
	line(
		"api.md",
		"2026-06-30",
		"Rate limiting is handled at the gateway; don't add it in services",
	),
	line(
		"api.md",
		"2026-08-14",
		"Until the v2 launch on 2026-09-30, new HTTP routes go under /v1beta instead of /api/v2",
		"expired",
		"2026-09-30",
	),

	// config.md: APP_ -> SVC_ (-> ACME_ in an update chat); flags.
	line(
		"config.md",
		"2026-02-09",
		"Feature flags live in flags.py as a dict of name -> default",
	),
	line(
		"config.md",
		"2026-02-09",
		'Feature flag names are kebab-case strings, like "new-checkout"',
		"old-valid",
	),
	line(
		"config.md",
		"2026-03-04",
		"Environment variables for this service are prefixed APP_",
		"superseded",
	),
	line(
		"config.md",
		"2026-03-04",
		"Config is read once at startup in config.py; no os.environ calls elsewhere",
	),
	line(
		"config.md",
		"2026-04-01",
		"Secrets come from Doppler in prod and .env locally",
	),
	line(
		"config.md",
		"2026-05-15",
		"Default timeouts are 10 seconds unless stated otherwise",
	),
	line(
		"config.md",
		"2026-07-28",
		"During the flag-service migration (until 2026-09-15), new feature flags need a tmp_ prefix",
		"expired",
		"2026-09-15",
	),
	line(
		"config.md",
		"2026-08-11",
		"Env var prefix changed from APP_ to SVC_ (ops naming standard)",
		"superseded",
	),

	// style.md: copyright -> SPDX; the FREEZE banner has expired.
	line(
		"style.md",
		"2026-01-12",
		'New source files start with the line "# Copyright (c) Acme Corp"',
		"superseded",
	),
	line("style.md", "2026-01-30", "Python: f-strings, never % formatting"),
	line("style.md", "2026-01-30", "Max line length is 100"),
	line("style.md", "2026-02-01", "Don't add comments that restate the code"),
	line("style.md", "2026-02-14", "Prefer pathlib over os.path"),
	line("style.md", "2026-03-11", "Type hints on public functions"),
	line(
		"style.md",
		"2026-03-22",
		"Use dataclasses for plain records, not dicts",
	),
	line("style.md", "2026-04-18", "JS: named exports only, no default exports"),
	line("style.md", "2026-05-08", "Module docstrings are optional"),
	line(
		"style.md",
		"2026-05-30",
		'License headers: replaced the copyright line with "# SPDX-License-Identifier: Apache-2.0" as the first line of new source files',
		"latest",
	),
	line(
		"style.md",
		"2026-06-11",
		"Prefer pathlib to os.path for file paths",
		"near-duplicate",
	),
	line(
		"style.md",
		"2026-09-20",
		'Until release 4.2 ships on 2026-10-01, put a "# FREEZE: release 4.2" banner line at the top of every new file',
		"expired",
		"2026-10-01",
	),

	// data.md
	line(
		"data.md",
		"2026-01-08",
		"Money amounts are integer cents, never floats",
		"old-valid",
	),
	line("data.md", "2026-01-08", "Postgres 16 is the database"),
	line("data.md", "2026-01-08", "IDs are UUIDv4 strings"),
	line(
		"data.md",
		"2026-02-22",
		"SQL migrations live in db/migrations and are named YYYYMMDDHHMM_<snake_slug>.sql (12-digit timestamp)",
		"old-valid",
	),
	line(
		"data.md",
		"2026-02-22",
		"Never edit an applied migration; add a new one",
	),
	line(
		"data.md",
		"2026-03-29",
		"Currency codes are ISO 4217 uppercase strings",
	),
	line(
		"data.md",
		"2026-04-27",
		"Soft-delete users with deleted_at; never DELETE user rows",
	),
	line(
		"data.md",
		"2026-05-21",
		"Tax is computed on the order total and rounded half-up to the cent",
	),
	line(
		"data.md",
		"2026-05-24",
		"Pin numpy<2 in requirements.txt until the pandas upgrade lands (2026-07-01)",
		"expired",
		"2026-07-01",
	),
	line("data.md", "2026-06-08", "Reporting queries run on the read replica"),
	line(
		"data.md",
		"2026-07-15",
		'While the data migration runs (until 2026-08-31), log messages must start with "[migration]"',
		"expired",
		"2026-08-31",
	),

	// git.md: Conventional Commits -> imperative subjects.
	line(
		"git.md",
		"2025-12-10",
		"Commit messages use Conventional Commits (feat:, fix:)",
		"superseded",
	),
	line("git.md", "2026-01-05", "Squash-merge PRs"),
	line("git.md", "2026-02-17", "Branch names: <initials>/<topic>"),
	line("git.md", "2026-02-17", "Don't commit generated files under dist/"),
	line("git.md", "2026-03-25", "PR descriptions say how the change was tested"),
	line(
		"git.md",
		"2026-04-03",
		"Dropped Conventional Commits; commit subjects are plain imperative sentences",
	),

	// deploy.md: deploy day flipped.
	line(
		"deploy.md",
		"2026-01-16",
		"Production deploys happen on Fridays",
		"superseded",
	),
	line("deploy.md", "2026-02-04", "Staging deploys from main automatically"),
	line("deploy.md", "2026-02-04", "Production deploys need Het's approval"),
	line("deploy.md", "2026-03-06", "Health checks hit /api/v2/health"),
	line("deploy.md", "2026-03-14", "Roll back with `make rollback ENV=prod`"),
	line("deploy.md", "2026-04-10", "Containers run as the non-root user app"),
	line("deploy.md", "2026-05-09", "No production deploys on Fridays anymore"),
	line(
		"deploy.md",
		"2026-07-30",
		"Fly.io deploys fail when the Dockerfile EXPOSE port differs from fly.toml internal_port",
	),

	// people.md: on-call changed hands.
	line(
		"people.md",
		"2026-01-05",
		"Het leads the project and reviews architecture changes",
	),
	line(
		"people.md",
		"2026-02-10",
		"Mara owns the mobile app and consumes the API",
	),
	line("people.md", "2026-02-10", "Design reviews with Lea are on Tuesdays"),
	line(
		"people.md",
		"2026-03-15",
		"Jonas is the DBA; ping him for migrations touching more than 1M rows",
	),
	line("people.md", "2026-04-01", "Sam is on call", "superseded"),
	line(
		"people.md",
		"2026-05-26",
		"Contractor Ade works on the reporting service only",
	),
	line(
		"people.md",
		"2026-07-01",
		"Priya took over on-call from Sam this quarter",
	),

	// gotchas.md
	line(
		"gotchas.md",
		"2026-02-28",
		"Run pytest from the repo root, otherwise conftest.py is not found",
	),
	line("gotchas.md", "2026-03-08", "macOS sed needs -i ''"),
	line(
		"gotchas.md",
		"2026-04-16",
		"CI runs in UTC and laptops don't; use timezone-aware datetimes",
	),
	line(
		"gotchas.md",
		"2026-05-13",
		"pnpm install in CI needs --frozen-lockfile",
	),
	line("gotchas.md", "2026-06-15", "uv sync must run after switching branches"),
	line(
		"gotchas.md",
		"2026-06-23",
		"The reporting service tests have no Docker daemon; use the fake in tests/fakes.py",
	),
	line(
		"gotchas.md",
		"2026-07-12",
		"The Stripe sandbox rate-limits at 25 req/s; batch webhook replays",
	),
	line(
		"gotchas.md",
		"2026-08-20",
		"Node 22 fetch rejects the staging self-signed cert; set NODE_EXTRA_CA_CERTS",
	),

	// preferences.md
	line("preferences.md", "2026-01-05", "Uses dark mode in every app"),
	line("preferences.md", "2026-01-22", "Prefers Vim keybindings in editors"),
	line("preferences.md", "2026-02-01", "Prefers concise PR descriptions"),
	line("preferences.md", "2026-02-01", "Likes small, focused commits"),
	line("preferences.md", "2026-02-12", "No emojis in code or commit messages"),
	line("preferences.md", "2026-03-03", "Explain trade-offs only when asked"),
	line(
		"preferences.md",
		"2026-04-30",
		"Keep replies short and to the point",
		"near-duplicate",
	),
	line("preferences.md", "2026-06-06", "Prefers tables for comparisons"),

	// frontend.md: CSS modules -> Tailwind.
	line("frontend.md", "2026-02-19", "Frontend is React 19 with Vite"),
	line(
		"frontend.md",
		"2026-02-19",
		"Styling uses CSS modules, not Tailwind",
		"superseded",
	),
	line("frontend.md", "2026-03-27", "Icons come from lucide-react"),
	line("frontend.md", "2026-04-05", "Forms use react-hook-form"),
	line("frontend.md", "2026-05-01", "Dates in the UI are shown as YYYY-MM-DD"),
	line(
		"frontend.md",
		"2026-08-25",
		"Moved the frontend from CSS modules to Tailwind",
	),

	// observability.md
	line(
		"observability.md",
		"2026-02-26",
		"Logs go through the logging module with the JSON formatter in log.py",
	),
	line(
		"observability.md",
		"2026-02-26",
		"Use log.info for business events and log.debug for internals",
	),
	line(
		"observability.md",
		"2026-02-26",
		"Don't log request bodies; they can hold PII",
	),
	line(
		"observability.md",
		"2026-03-30",
		"Metrics go through OpenTelemetry to Grafana Cloud",
	),
	line(
		"observability.md",
		"2026-04-08",
		"Sentry captures exceptions in prod only",
	),
	line(
		"observability.md",
		"2026-05-27",
		"Trace IDs propagate via the traceparent header",
	),
	line("observability.md", "2026-06-19", "Dashboards live in grafana/ as JSON"),
	line(
		"observability.md",
		"2026-07-17",
		"Alert when p95 latency is above 800 ms for 5 minutes",
	),

	// security.md: token lifetime changed.
	line("security.md", "2026-01-25", "Passwords are hashed with argon2id"),
	line("security.md", "2026-01-25", "Never log tokens or email addresses"),
	line("security.md", "2026-02-08", "JWTs expire after 24 hours", "superseded"),
	line(
		"security.md",
		"2026-03-17",
		"The CORS allowlist is ALLOWED_ORIGINS in config.py",
	),
	line(
		"security.md",
		"2026-03-17",
		"Session cookies are HttpOnly, Secure and SameSite=Lax",
	),
	line(
		"security.md",
		"2026-05-14",
		"Dependabot PRs are merged weekly by whoever is on call",
	),
	line("security.md", "2026-06-03", "gitleaks scans for secrets in CI"),
	line(
		"security.md",
		"2026-07-25",
		"Access tokens now expire after 1 hour, with refresh tokens",
	),

	// reporting.md
	line(
		"reporting.md",
		"2026-03-09",
		"The reporting service has no internet access; stdlib only there",
	),
	line("reporting.md", "2026-03-09", "Reports are UTF-8 CSV with a header row"),
	line(
		"reporting.md",
		"2026-04-20",
		"Monthly reports run on the 1st at 06:00 UTC",
	),
	line(
		"reporting.md",
		"2026-04-20",
		"Report filenames are report_<YYYY-MM>.csv",
	),
	line(
		"reporting.md",
		"2026-05-26",
		"Ade owns the report formats",
		"near-duplicate",
	),
	line(
		"reporting.md",
		"2026-08-05",
		"Large exports are streamed, not built in memory",
	),

	// mobile.md
	line(
		"mobile.md",
		"2026-02-10",
		"The mobile app pins API v2 and needs two weeks' notice before breaking changes",
	),
	line("mobile.md", "2026-04-23", "Push notifications go through OneSignal"),
	line(
		"mobile.md",
		"2026-06-26",
		"The mobile release train leaves every second Thursday",
	),

	// search.md, billing.md, infra.md: more distractors.
	line(
		"search.md",
		"2026-03-13",
		"Search uses Postgres full-text search, not Elasticsearch",
	),
	line(
		"search.md",
		"2026-04-29",
		"Search queries are logged without the query text",
	),
	line("search.md", "2026-06-17", "Search results cap at 50 per page"),
	line(
		"billing.md",
		"2026-02-27",
		"Stripe is the payment provider; webhooks land on /api/v2/stripe/webhook",
	),
	line(
		"billing.md",
		"2026-04-11",
		"Invoices are generated on the 1st of the month",
	),
	line(
		"billing.md",
		"2026-06-24",
		"Refunds over 500 USD need a second approver",
	),
	line(
		"billing.md",
		"2026-07-09",
		"Prices shown to users include VAT for EU customers",
	),
	line(
		"infra.md",
		"2026-01-18",
		"Infrastructure is managed with Terraform in infra/",
	),
	line(
		"infra.md",
		"2026-03-24",
		"Staging runs on Fly.io; production on AWS ECS",
	),
	line(
		"infra.md",
		"2026-05-17",
		"Redis is only a cache; never store source-of-truth data in it",
	),
	line(
		"infra.md",
		"2026-07-19",
		"Background jobs run on Celery with the Redis broker",
	),
	line(
		"infra.md",
		"2026-08-28",
		"Backups are taken nightly at 02:00 UTC and kept for 30 days",
	),
];

export const SEED_SOURCE = (date: string) =>
	`https://ytimesy.test/?chat=seed-${date}`;

/** A history line as our memory repo stores it. */
export function bulletFor(entry: HistoryLine) {
	const meta = [
		entry.expires ? `expires: ${entry.expires}` : null,
		`source: ${SEED_SOURCE(entry.added)}`,
		`added: ${entry.added}`,
	].filter(Boolean);
	return `- ${entry.text} [${meta.join("; ")}]`;
}

/** The seeded repo for our arm: topic files linked from MEMORY.md's index. */
export function seedFiles(history: readonly HistoryLine[] = HISTORY) {
	const byFile = new Map<string, HistoryLine[]>();
	for (const entry of history)
		byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
	const files: Record<string, string> = {};
	const topics = [...byFile.keys()].filter((path) => path !== "MEMORY.md");
	for (const path of topics) {
		const title = path.replace(/\.md$/, "");
		files[path] =
			`# ${title}\n${(byFile.get(path) ?? []).map(bulletFor).join("\n")}\n`;
	}
	files["MEMORY.md"] = [
		"# Memory",
		"",
		...(byFile.get("MEMORY.md") ?? []).map(bulletFor),
		"",
		"## Index",
		...topics.map((path) => `- [[${path.replace(/\.md$/, "")}]]`),
		"",
	].join("\n");
	return files;
}

/**
 * The same history for Supermemory, as their Claude Code plugin would have
 * produced it: one captured chat per month, oldest first, in capture.js's
 * turn format, where the user states that month's decisions (each with its
 * date, and expiring ones with their end date in the text). One document per
 * month (not per topic file), because the plugin captures chats, not files.
 */
export function supermemorySeedDocuments(
	history: readonly HistoryLine[] = HISTORY,
) {
	const months = new Map<string, HistoryLine[]>();
	for (const entry of [...history].sort((a, b) =>
		a.added.localeCompare(b.added),
	)) {
		const month = entry.added.slice(0, 7);
		months.set(month, [...(months.get(month) ?? []), entry]);
	}
	return [...months.entries()].map(([month, entries]) => {
		const last = entries[entries.length - 1].added;
		const user = [
			"Notes for this project from this month, please remember them:",
			...entries.map((entry) => `- (${entry.added}) ${entry.text}`),
		].join("\n");
		return {
			month,
			timestamp: `${last}T17:00:00.000Z`,
			content: [
				`<|turn_start|>${last}T17:00:00.000Z`,
				`<|start|>user<|message|>${user}<|end|>`,
				"<|start|>assistant<|message|>Noted. I'll follow these in this project from now on.<|end|>",
				"<|turn_end|>",
			].join("\n\n"),
		};
	});
}

// ---------------------------------------------------------------------------
// Chats

export type LongChat = {
	id: string;
	prompt: string;
	files: Record<string, string>;
};

export type ProbeType =
	| "exception"
	| "latest-seed"
	| "latest-update"
	| "indirect"
	| "expired"
	| "old-valid"
	| "freshness";

export type Probe = LongChat & {
	type: ProbeType;
	/** The fact the verifier checks, in words. */
	fact: string;
	verify: string;
	/** In memory text: the current fact. */
	right: RegExp;
	/** In memory text: a superseded or expired version of it. */
	stale?: RegExp;
	/** Words that would leak the fact into the prompt or fixture. */
	leaks: RegExp;
	solutions: {
		follows: Record<string, string | null>;
		breaks: Record<string, string | null>;
	};
};

/**
 * Whether a stale version of the probe's fact is in this memory text: a line
 * matching `stale` that does not also state the current fact (a new line
 * that names the decision it replaced, "Vitest is being dropped", is not stale).
 */
export function staleLineIn(probe: Probe, text: string) {
	const { stale } = probe;
	return stale
		? text
				.split("\n")
				.some((line) => stale.test(line) && !probe.right.test(line))
		: false;
}

const py = (lines: string[]) => `${lines.join("\n")}\n`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const GITIGNORE = "node_modules/\n__pycache__/\n";
const pkg = (name: string, dependencies: Record<string, string> = {}) =>
	json({ name, version: "1.0.0", private: true, type: "module", dependencies });
const fail = (message: string) => `{ echo '${message}'; exit 1; }`;

/** Update chats, in order: the user changes or adds a decision in passing. */
export const UPDATES: LongChat[] = [
	{
		id: "u1-node-test",
		prompt:
			"Add src/clamp.js exporting clamp(n, min, max). Also, we're dropping Vitest: new JS tests use the built-in node:test runner with node:assert/strict, no test framework dependency.",
		files: { ".gitignore": GITIGNORE, "package.json": pkg("acme-web") },
	},
	{
		id: "u2-env-acme",
		prompt:
			"In config.py, add a DEBUG setting read from the environment (default off). Heads-up: platform renamed our env var prefix again, new env vars use ACME_ from now on; the existing SVC_ ones stay until they're migrated.",
		files: {
			"config.py": py([
				"import os",
				"",
				'DB_URL = os.environ.get("SVC_DB_URL", "postgresql://localhost/app")',
			]),
		},
	},
	{
		id: "u3-error-upper",
		prompt:
			"In routes.py, make POST /orders return 400 when the body has no items. Mara's team asked that error codes be UPPER_SNAKE_CASE from now on, like ITEMS_REQUIRED.",
		files: {
			"routes.py": py([
				"def handle(method, path, body=None):",
				"    if method == 'POST' and path == '/orders':",
				"        return 201, {'id': '1', 'items': body['items']}",
				"    return 404, None",
			]),
		},
	},
	{
		id: "u4-ts-ms",
		prompt:
			"Add created_at to Comment.to_dict() in comments.py. We're changing timestamps again: API responses carry epoch milliseconds as integers from now on.",
		files: {
			"comments.py": py([
				"from dataclasses import dataclass",
				"from datetime import datetime",
				"",
				"",
				"@dataclass",
				"class Comment:",
				"    id: str",
				"    body: str",
				"    created_at: datetime",
				"",
				"    def to_dict(self):",
				"        return {'id': self.id, 'body': self.body}",
			]),
		},
	},
	{
		id: "u5-tools-dir",
		prompt:
			"Add a small command-line script that prints today's date in UTC. Also, we're renaming scripts/ to tools/: new CLI scripts go in tools/; the old ones in scripts/ get moved later.",
		files: {
			"scripts/cleanup_tmp.py": py([
				"import argparse",
				"import pathlib",
				"",
				"",
				"def main():",
				"    parser = argparse.ArgumentParser()",
				"    parser.add_argument('dir')",
				"    args = parser.parse_args()",
				"    for path in pathlib.Path(args.dir).glob('*.tmp'):",
				"        path.unlink()",
				"",
				"",
				"if __name__ == '__main__':",
				"    main()",
			]),
		},
	},
	{
		id: "u6-cents-restated",
		prompt:
			"Add discount(amount, percent) to billing.py that returns the discounted amount. Reminder: money is always integer cents in this codebase.",
		files: { "billing.py": "" },
	},
];

const ROUTES_EMPTY = py([
	"USERS = {'1': {'id': '1', 'name': 'Ann'}}",
	"",
	"",
	"def handle(method, path):",
	"    if method == 'GET' and path == '/health':",
	"        return 200, {'ok': True}",
	"    return 404, None",
]);
const usersRoute = (notFound: string) =>
	py([
		"USERS = {'1': {'id': '1', 'name': 'Ann'}}",
		"",
		"",
		"def handle(method, path):",
		"    if method == 'GET' and path.startswith('/users/'):",
		"        user = USERS.get(path.split('/')[2])",
		"        if user is None:",
		`            return 404, ${notFound}`,
		"        return 200, user",
		"    if method == 'GET' and path == '/health':",
		"        return 200, {'ok': True}",
		"    return 404, None",
	]);

const EVENTS = py([
	"from dataclasses import dataclass",
	"from datetime import datetime",
	"",
	"",
	"@dataclass",
	"class Event:",
	"    id: str",
	"    name: str",
	"    created_at: datetime",
]);
const eventsWith = (createdAt: string) =>
	`${EVENTS}\n\ndef event_to_json(event):\n    return {'id': event.id, 'name': event.name, 'created_at': ${createdAt}}\n`;

const FLAGS = py([
	"# Feature flags: name -> default.",
	"FLAGS: dict[str, bool] = {}",
	"",
	"",
	"def enabled(name: str) -> bool:",
	"    return FLAGS.get(name, False)",
]);
const ROUTE_REGISTRY = py([
	"ROUTES = {}",
	"",
	"",
	"def route(path):",
	"    def register(handler):",
	"        ROUTES[path] = handler",
	"        return handler",
	"    return register",
]);
const versionRoute = (path: string) =>
	`${ROUTE_REGISTRY}\n\n@route('${path}')\ndef version():\n    return {'version': open('VERSION').read().strip()}\n`;

const CONFIG = py([
	"import os",
	"",
	'DB_URL = os.environ.get("SVC_DB_URL", "postgresql://localhost/app")',
	'LOG_LEVEL = os.environ.get("SVC_LOG_LEVEL", "INFO")',
]);
const SCRIPTS_CLEANUP = UPDATES[4].files["scripts/cleanup_tmp.py"];
const COUNT_USERS = py([
	"import csv",
	"import sys",
	"",
	"path = sys.argv[1] if len(sys.argv) > 1 else 'data/users.csv'",
	"with open(path, newline='') as handle:",
	"    print(sum(1 for _ in csv.DictReader(handle)))",
]);
const PNPM_LOCK = (name: string) =>
	`lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      ${name}:\n        specifier: ^1.0.0\n        version: 1.0.0\n`;
const NPM_LOCK = (name: string) =>
	`{"lockfileVersion":3,"packages":{"node_modules/${name}":{"version":"1.0.0"}}}\n`;

/** Each verifier runs at the probe's repository root; exit 0 = the fact was followed. */
export const PROBES: Probe[] = [
	{
		id: "legacy-npm",
		type: "exception",
		fact: "pnpm everywhere except legacy/, which uses npm",
		prompt:
			"Add the `ms` package to the legacy/ app and add legacy/src/duration.js exporting toMs(text) that returns ms(text).",
		files: {
			".gitignore": GITIGNORE,
			"package.json": pkg("acme-web"),
			"src/index.js": "export {};\n",
			"legacy/package.json": pkg("acme-legacy"),
			"legacy/src/index.js": "export {};\n",
		},
		verify: [
			`grep -q '"ms"' legacy/package.json || ${fail("ms not in legacy/package.json")}`,
			`test ! -e legacy/pnpm-lock.yaml || ${fail("legacy/ installed with pnpm: the exception was ignored")}`,
			`test -f legacy/package-lock.json || ${fail("no legacy/package-lock.json")}`,
			`grep -q 'node_modules/ms' legacy/package-lock.json || ${fail("ms not in legacy/package-lock.json")}`,
			`test -f legacy/src/duration.js || ${fail("legacy/src/duration.js missing")}`,
		].join("\n"),
		right: /legacy[^\n]{0,80}npm|npm[^\n]{0,80}legacy/i,
		stale: /\buse npm for installs\b/i,
		leaks: /pnpm|\bnpm\b|lockfile|package manager/i,
		solutions: {
			follows: {
				"legacy/package.json": pkg("acme-legacy", { ms: "^2.1.3" }),
				"legacy/package-lock.json": NPM_LOCK("ms"),
				"legacy/src/duration.js":
					"import ms from 'ms';\nexport const toMs = (text) => ms(text);\n",
			},
			breaks: {
				"legacy/package.json": pkg("acme-legacy", { ms: "^2.1.3" }),
				"legacy/pnpm-lock.yaml": PNPM_LOCK("ms"),
				"legacy/src/duration.js":
					"import ms from 'ms';\nexport const toMs = (text) => ms(text);\n",
			},
		},
	},
	{
		id: "root-pnpm",
		type: "latest-seed",
		fact: "installs use pnpm (npm -> pnpm)",
		prompt:
			"Install dayjs and add src/day.js exporting formatDay(date) that returns dayjs(date).format('YYYY-MM-DD').",
		files: {
			".gitignore": GITIGNORE,
			"package.json": pkg("acme-web"),
			"src/index.js": "export {};\n",
		},
		verify: [
			`grep -q dayjs package.json || ${fail("dayjs not in package.json")}`,
			`test ! -e package-lock.json || ${fail("npm lockfile created: followed the old decision")}`,
			`test -f pnpm-lock.yaml || ${fail("no pnpm-lock.yaml")}`,
			`grep -q dayjs pnpm-lock.yaml || ${fail("dayjs not in pnpm-lock.yaml")}`,
		].join("\n"),
		right: /pnpm/i,
		stale: /\buse npm for installs\b/i,
		leaks: /pnpm|\bnpm\b|lockfile|package manager/i,
		solutions: {
			follows: {
				"package.json": pkg("acme-web", { dayjs: "^1.11.13" }),
				"pnpm-lock.yaml": PNPM_LOCK("dayjs"),
				"src/day.js":
					"import dayjs from 'dayjs';\nexport const formatDay = (date) => dayjs(date).format('YYYY-MM-DD');\n",
			},
			breaks: {
				"package.json": pkg("acme-web", { dayjs: "^1.11.13" }),
				"package-lock.json": NPM_LOCK("dayjs"),
				"src/day.js":
					"import dayjs from 'dayjs';\nexport const formatDay = (date) => dayjs(date).format('YYYY-MM-DD');\n",
			},
		},
	},
	{
		id: "node-test",
		type: "latest-update",
		fact: "JS tests use node:test (Jest -> Vitest -> node:test)",
		prompt:
			"Add unit tests for src/clamp.js covering the in-range, below-min and above-max cases.",
		files: {
			".gitignore": GITIGNORE,
			"package.json": pkg("acme-web"),
			"src/clamp.js":
				"export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));\n",
		},
		verify: [
			"files=$(git ls-files --others --modified --exclude-standard | grep -E '\\.(test|spec)\\.[cm]?js$|^tests?/.*\\.[cm]?js$' || true)",
			`[ -n "$files" ] || ${fail("no test file")}`,
			`! grep -Eq '"(vitest|jest)"' package.json || ${fail("vitest/jest dependency added: followed an old decision")}`,
			`! grep -Eq "from ['\\"](vitest|@jest/globals)['\\"]|require\\(['\\"](vitest|jest)" $files || ${fail("tests import vitest/jest")}`,
			`grep -q 'node:test' $files || ${fail("tests do not use node:test")}`,
			`node --test $files >/dev/null 2>&1 || ${fail("node --test fails")}`,
		].join("\n"),
		right: /node:test/i,
		stale: /vitest|jest/i,
		leaks: /node:test|vitest|jest|runner/i,
		solutions: {
			follows: {
				"test/clamp.test.js": [
					"import { test } from 'node:test';",
					"import assert from 'node:assert/strict';",
					"import { clamp } from '../src/clamp.js';",
					"test('clamp', () => {",
					"  assert.equal(clamp(5, 0, 10), 5);",
					"  assert.equal(clamp(-1, 0, 10), 0);",
					"  assert.equal(clamp(11, 0, 10), 10);",
					"});",
					"",
				].join("\n"),
			},
			breaks: {
				"package.json": json({
					name: "acme-web",
					version: "1.0.0",
					private: true,
					type: "module",
					dependencies: {},
					devDependencies: { vitest: "^3.0.0" },
				}),
				"src/clamp.test.js": [
					"import { expect, test } from 'vitest';",
					"import { clamp } from './clamp.js';",
					"test('clamp', () => { expect(clamp(5, 0, 10)).toBe(5); });",
					"",
				].join("\n"),
			},
		},
	},
	{
		id: "env-acme",
		type: "indirect",
		fact: "new env vars use the ACME_ prefix (APP_ -> SVC_ -> ACME_; existing SVC_ stay)",
		prompt:
			"Make the outbound HTTP request timeout configurable in config.py, the same way our other settings are configured (default 10 seconds).",
		files: { "config.py": CONFIG },
		verify: [
			"python3 - <<'PY'",
			"import importlib, os, re, sys",
			"sys.path.insert(0, '.')",
			"names = set(re.findall(r'[\"\\'](?:ACME|SVC|APP)_[A-Z0-9_]+[\"\\']', open('config.py').read()))",
			"names = {n.strip('\"\\'') for n in names} - {'SVC_DB_URL', 'SVC_LOG_LEVEL'}",
			"timeouts = [n for n in names if 'TIMEOUT' in n]",
			"if not timeouts: sys.exit('no new *TIMEOUT* env var in config.py')",
			"bad = [n for n in timeouts if not n.startswith('ACME_')]",
			"if bad: sys.exit(f'old prefix used: {bad}')",
			"os.environ[timeouts[0]] = '7'",
			"config = importlib.import_module('config')",
			"if not any(isinstance(v, (int, float)) and not isinstance(v, bool) and v == 7 for v in vars(config).values()): sys.exit('timeout env var is not read')",
			"PY",
		].join("\n"),
		right: /ACME_/,
		stale: /\bSVC_|\bAPP_/,
		leaks: /ACME/,
		solutions: {
			follows: {
				"config.py": `${CONFIG}HTTP_TIMEOUT = float(os.environ.get("ACME_HTTP_TIMEOUT", "10"))\n`,
			},
			breaks: {
				"config.py": `${CONFIG}HTTP_TIMEOUT = float(os.environ.get("SVC_HTTP_TIMEOUT", "10"))\n`,
			},
		},
	},
	{
		id: "error-upper",
		type: "indirect",
		fact: 'errors are {"error": {"code": UPPER_SNAKE, "message"}}',
		prompt:
			"Add GET /users/<id> to routes.py that returns the user, and handle a missing user the way the rest of our API handles not-found.",
		files: { "routes.py": ROUTES_EMPTY },
		verify: [
			"python3 - <<'PY'",
			"import re, sys",
			"sys.path.insert(0, '.')",
			"from routes import handle",
			"status, body = handle('GET', '/users/1')",
			"assert status == 200 and body['name'] == 'Ann', (status, body)",
			"status, body = handle('GET', '/users/404')",
			"assert status == 404, status",
			"if not (isinstance(body, dict) and set(body) == {'error'} and isinstance(body['error'], dict)): sys.exit(f'not the error shape: {body}')",
			"code, message = body['error'].get('code'), body['error'].get('message')",
			"if not (isinstance(message, str) and message): sys.exit(f'no message: {body}')",
			"if not (isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9]*(_[A-Z0-9]+)*', code)): sys.exit(f'code is not UPPER_SNAKE_CASE: {code!r}')",
			"PY",
		].join("\n"),
		right: /UPPER_SNAKE|ITEMS_REQUIRED/i,
		stale: /snake_case_code|"error": "<message>"/i,
		leaks: /error|code|message|UPPER/i,
		solutions: {
			follows: {
				"routes.py": usersRoute(
					"{'error': {'code': 'USER_NOT_FOUND', 'message': 'No such user'}}",
				),
			},
			breaks: {
				"routes.py": usersRoute(
					"{'error': {'code': 'user_not_found', 'message': 'No such user'}}",
				),
			},
		},
	},
	{
		id: "ts-ms",
		type: "latest-update",
		fact: "API timestamps are epoch milliseconds (unix s -> ISO -> ms)",
		prompt:
			"Add event_to_json(event) in events.py that turns an Event into the dict our API responses return (id, name, created_at).",
		files: { "events.py": EVENTS },
		verify: [
			"python3 - <<'PY'",
			"import sys",
			"from datetime import datetime, timezone",
			"sys.path.insert(0, '.')",
			"from events import Event, event_to_json",
			"moment = datetime(2026, 5, 1, 12, 0, 0, tzinfo=timezone.utc)",
			"value = event_to_json(Event('e1', 'Launch', moment))['created_at']",
			"if isinstance(value, bool) or not isinstance(value, int): sys.exit(f'created_at is not an integer: {value!r}')",
			"if value != int(moment.timestamp() * 1000): sys.exit(f'created_at is not epoch milliseconds: {value!r}')",
			"PY",
		].join("\n"),
		right: /milli/i,
		stale: /ISO 8601|unix seconds/i,
		leaks: /milli|epoch|iso|unix|timestamp/i,
		solutions: {
			follows: {
				"events.py": eventsWith("int(event.created_at.timestamp() * 1000)"),
			},
			breaks: {
				"events.py": eventsWith(
					"event.created_at.isoformat().replace('+00:00', 'Z')",
				),
			},
		},
	},
	{
		id: "spdx-header",
		type: "latest-seed",
		fact: "new source files start with the SPDX Apache-2.0 line (copyright line -> SPDX)",
		prompt:
			"Add util/slug.py with slugify(text) that lowercases the text and joins its words with '-'.",
		files: { "README.md": "Utilities.\n", "util/__init__.py": "" },
		verify: [
			`test -f util/slug.py || ${fail("util/slug.py missing")}`,
			`head -n 3 util/slug.py | grep -qx '# SPDX-License-Identifier: Apache-2.0' || ${fail("no SPDX line at the top")}`,
			`! grep -qi 'copyright' util/slug.py || ${fail("old copyright line applied")}`,
			`python3 -c "import sys; sys.path.insert(0, '.'); from util.slug import slugify; assert slugify('Hello Big World') == 'hello-big-world'" || ${fail("slugify is wrong")}`,
		].join("\n"),
		right: /SPDX/i,
		stale: /Copyright \(c\) Acme/i,
		leaks: /SPDX|copyright|license|header/i,
		solutions: {
			follows: {
				"util/slug.py": py([
					"# SPDX-License-Identifier: Apache-2.0",
					"",
					"",
					"def slugify(text):",
					"    return '-'.join(text.lower().split())",
				]),
			},
			breaks: {
				"util/slug.py": py([
					"# Copyright (c) Acme Corp",
					"",
					"",
					"def slugify(text):",
					"    return '-'.join(text.lower().split())",
				]),
			},
		},
	},
	{
		id: "flag-kebab",
		type: "expired",
		fact: "flag names are kebab-case; the tmp_ prefix rule expired",
		prompt: "Add a feature flag for the dark mode rollout, off by default.",
		files: { "flags.py": FLAGS },
		verify: [
			"python3 - <<'PY'",
			"import re, sys",
			"sys.path.insert(0, '.')",
			"from flags import FLAGS",
			"names = [n for n in FLAGS if 'dark' in n.lower()]",
			"if len(names) != 1: sys.exit(f'expected one dark mode flag: {list(FLAGS)}')",
			"name = names[0]",
			"if name.lower().startswith('tmp'): sys.exit(f'expired tmp_ prefix applied: {name}')",
			"if not re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)+', name): sys.exit(f'not kebab-case: {name}')",
			"if FLAGS[name] is not False: sys.exit('not off by default')",
			"PY",
		].join("\n"),
		right: /kebab/i,
		stale: /tmp_/i,
		leaks: /kebab|tmp_|prefix/i,
		solutions: {
			follows: { "flags.py": FLAGS.replace("= {}", "= {'dark-mode': False}") },
			breaks: {
				"flags.py": FLAGS.replace("= {}", "= {'tmp_dark-mode': False}"),
			},
		},
	},
	{
		id: "route-v2",
		type: "expired",
		fact: "routes go under /api/v2; the /v1beta rule expired",
		prompt:
			'Add an HTTP GET route in routes.py that returns the contents of the VERSION file as {"version": ...}.',
		files: { "routes.py": ROUTE_REGISTRY, VERSION: "1.4.2\n" },
		verify: [
			"python3 - <<'PY'",
			"import sys",
			"sys.path.insert(0, '.')",
			"from routes import ROUTES",
			"paths = [p for p in ROUTES if 'version' in p.lower()]",
			"if len(paths) != 1: sys.exit(f'expected one version route: {list(ROUTES)}')",
			"path = paths[0]",
			"if 'v1beta' in path: sys.exit(f'expired /v1beta rule applied: {path}')",
			"if not path.startswith('/api/v2/'): sys.exit(f'not under /api/v2: {path}')",
			"PY",
		].join("\n"),
		right: /\/api\/v2/i,
		stale: /v1beta/i,
		leaks: /api\/v2|v1beta|\/v2/i,
		solutions: {
			follows: { "routes.py": versionRoute("/api/v2/version") },
			breaks: { "routes.py": versionRoute("/v1beta/version") },
		},
	},
	{
		id: "cents",
		type: "old-valid",
		fact: "money is integer cents",
		prompt:
			'Add order_total(items, tax_rate) to billing.py: items is a list of {"price": ..., "qty": ...} dicts; return the order total including tax.',
		files: { "billing.py": "" },
		verify: [
			"python3 - <<'PY'",
			"import sys",
			"sys.path.insert(0, '.')",
			"from billing import order_total",
			"value = order_total([{'price': 1250, 'qty': 2}, {'price': 199, 'qty': 1}], 0.08)",
			"if isinstance(value, bool) or not isinstance(value, int): sys.exit(f'total is not integer cents: {value!r}')",
			"if value != 2915: sys.exit(f'wrong total: {value}')",
			"PY",
		].join("\n"),
		right: /cents/i,
		leaks: /cents|integer|float/i,
		solutions: {
			follows: {
				"billing.py": py([
					"from decimal import Decimal, ROUND_HALF_UP",
					"",
					"",
					"def order_total(items, tax_rate):",
					"    subtotal = sum(item['price'] * item['qty'] for item in items)",
					"    tax = (Decimal(subtotal) * Decimal(str(tax_rate))).quantize(Decimal(1), ROUND_HALF_UP)",
					"    return subtotal + int(tax)",
				]),
			},
			breaks: {
				"billing.py": py([
					"def order_total(items, tax_rate):",
					"    subtotal = sum(item['price'] * item['qty'] for item in items)",
					"    return round(subtotal * (1 + tax_rate), 2)",
				]),
			},
		},
	},
	{
		id: "migration-name",
		type: "old-valid",
		fact: "migrations are db/migrations/YYYYMMDDHHMM_<slug>.sql",
		prompt:
			"Add a database migration that adds a nullable nickname text column to the users table.",
		files: {
			"db/migrations/.gitkeep": "",
			"db/README.md": "Postgres schema and migrations.\n",
		},
		verify: [
			"files=$(git ls-files --others --exclude-standard | grep -i '\\.sql$' || true)",
			`[ -n "$files" ] || ${fail("no .sql migration added")}`,
			"for f in $files; do",
			`  case "$f" in db/migrations/*) ;; *) ${fail("migration outside db/migrations")} ;; esac`,
			`  basename "$f" | grep -Eq '^[0-9]{12}_[a-z0-9_]+\\.sql$' || ${fail("migration not named YYYYMMDDHHMM_<slug>.sql")}`,
			`  grep -qi nickname "$f" || ${fail("migration does not add nickname")}`,
			"done",
		].join("\n"),
		right: /YYYYMMDDHHMM/i,
		leaks: /YYYY|timestamp|naming|named/i,
		solutions: {
			follows: {
				"db/migrations/202610171200_add_users_nickname.sql":
					"alter table users add column nickname text;\n",
			},
			breaks: {
				"db/migrations/0001_add_users_nickname.sql":
					"alter table users add column nickname text;\n",
			},
		},
	},
	{
		id: "tools-dir",
		type: "latest-update",
		fact: "new CLI scripts go in tools/ (scripts/ -> tools/)",
		prompt:
			"Add a command-line script that prints how many users are in data/users.csv.",
		files: {
			"data/users.csv": "id,name\n1,Ann\n2,Bo\n3,Cy\n",
			"scripts/cleanup_tmp.py": SCRIPTS_CLEANUP,
		},
		verify: [
			"new=$(git ls-files --others --exclude-standard | grep -E '\\.(py|sh)$' || true)",
			`[ -n "$new" ] || ${fail("no script added")}`,
			`! printf '%s\\n' $new | grep -q '^scripts/' || ${fail("new script in scripts/: followed the old decision")}`,
			"tool=$(printf '%s\\n' $new | grep '^tools/' | head -n 1)",
			`[ -n "$tool" ] || ${fail("no new script in tools/")}`,
			'run() { case "$tool" in *.sh) bash "$tool" "$@";; *) python3 "$tool" "$@";; esac; }',
			`{ run data/users.csv 2>/dev/null || run 2>/dev/null; } | grep -qw 3 || ${fail("script does not print 3")}`,
		].join("\n"),
		right: /tools\//i,
		stale: /live in scripts\//i,
		leaks: /tools\/|scripts\/ |folder|directory/i,
		solutions: {
			follows: { "tools/count_users.py": COUNT_USERS },
			breaks: { "scripts/count_users.py": COUNT_USERS },
		},
	},
];

/** Freshness pairs: the probe starts within seconds of the update's end. */
export const FRESHNESS: { update: LongChat; probe: Probe }[] = [
	{
		update: {
			id: "f1-update",
			prompt:
				"Add util/nums.py with is_even(n). From now on, every new Python module we add must define __all__ listing its public names.",
			files: { "util/__init__.py": "" },
		},
		probe: {
			id: "f1-all",
			type: "freshness",
			fact: "new Python modules define __all__",
			prompt: "Add util/text.py with title_case(s) that capitalizes each word.",
			files: { "util/__init__.py": "" },
			verify: [
				"python3 - <<'PY'",
				"import sys",
				"sys.path.insert(0, '.')",
				"import util.text as text",
				"if 'title_case' not in getattr(text, '__all__', ()): sys.exit('no __all__ with title_case')",
				"if text.title_case('hello big world') != 'Hello Big World': sys.exit('title_case is wrong')",
				"PY",
			].join("\n"),
			right: /__all__/,
			leaks: /__all__|public names/i,
			solutions: {
				follows: {
					"util/text.py":
						"__all__ = ['title_case']\n\n\ndef title_case(s):\n    return ' '.join(w.capitalize() for w in s.split())\n",
				},
				breaks: {
					"util/text.py":
						"def title_case(s):\n    return ' '.join(w.capitalize() for w in s.split())\n",
				},
			},
		},
	},
	{
		update: {
			id: "f2-update",
			prompt:
				'Add config/app.json containing {"name": "acme"}. Heads-up: JSON files we add use 4-space indentation from now on.',
			files: { "config/.gitkeep": "" },
		},
		probe: {
			id: "f2-json-indent",
			type: "freshness",
			fact: "new JSON files use 4-space indentation",
			prompt:
				"Add config/limits.json with max_upload_mb set to 25 and max_files set to 10.",
			files: { "config/.gitkeep": "" },
			verify: [
				"python3 - <<'PY'",
				"import json, sys",
				"text = open('config/limits.json').read()",
				"data = json.loads(text)",
				"if data.get('max_upload_mb') != 25 or data.get('max_files') != 10: sys.exit(f'wrong values: {data}')",
				"lines = [l for l in text.splitlines() if l.strip().startswith('\"')]",
				"if not lines or any(len(l) - len(l.lstrip(' ')) != 4 for l in lines): sys.exit('not 4-space indented')",
				"PY",
			].join("\n"),
			right: /4.space|four.space/i,
			leaks: /indent|4.space|spaces/i,
			solutions: {
				follows: {
					"config/limits.json": `${JSON.stringify({ max_upload_mb: 25, max_files: 10 }, null, 4)}\n`,
				},
				breaks: {
					"config/limits.json": `${JSON.stringify({ max_upload_mb: 25, max_files: 10 }, null, 2)}\n`,
				},
			},
		},
	},
	{
		update: {
			id: "f3-update",
			prompt:
				"In orders.py, log 'cancelling order <id>' at info level in cancel_order. Starting now, every log message in orders.py must start with [orders].",
			files: {
				"orders.py": py([
					"import logging",
					"",
					"log = logging.getLogger(__name__)",
					"",
					"",
					"def cancel_order(order_id):",
					"    return {'id': order_id, 'status': 'cancelled'}",
				]),
			},
		},
		probe: {
			id: "f3-log-prefix",
			type: "freshness",
			fact: "log messages in orders.py start with [orders]",
			prompt:
				"In orders.py, log 'processing order <id>' at info level when process_order starts.",
			files: {
				"orders.py": py([
					"import logging",
					"",
					"log = logging.getLogger(__name__)",
					"",
					"",
					"def process_order(order_id):",
					"    return {'id': order_id, 'status': 'processing'}",
				]),
			},
			verify: [
				"python3 - <<'PY'",
				"import logging, sys",
				"sys.path.insert(0, '.')",
				"records = []",
				"class Keep(logging.Handler):",
				"    def emit(self, record):",
				"        records.append(record.getMessage())",
				"root = logging.getLogger()",
				"root.addHandler(Keep())",
				"root.setLevel(logging.DEBUG)",
				"import orders",
				"orders.process_order('42')",
				"hits = [m for m in records if '42' in m]",
				"if not hits: sys.exit(f'no log line with the id: {records}')",
				"if not hits[0].startswith('[orders]'): sys.exit(f'no [orders] prefix: {hits[0]!r}')",
				"PY",
			].join("\n"),
			right: /\[orders\]/,
			stale: /\[migration\]/,
			leaks: /\[orders\]|prefix/i,
			solutions: {
				follows: {
					"orders.py": py([
						"import logging",
						"",
						"log = logging.getLogger(__name__)",
						"",
						"",
						"def process_order(order_id):",
						"    log.info('[orders] processing order %s', order_id)",
						"    return {'id': order_id, 'status': 'processing'}",
					]),
				},
				breaks: {
					"orders.py": py([
						"import logging",
						"",
						"log = logging.getLogger(__name__)",
						"",
						"",
						"def process_order(order_id):",
						"    log.info('processing order %s', order_id)",
						"    return {'id': order_id, 'status': 'processing'}",
					]),
				},
			},
		},
	},
];

/**
 * Expired rules leaking into any probe's output: run after every probe on
 * its changes (new and modified files), whatever the probe checks.
 */
export const EXPIRED_LEAK_CHECK = [
	"changed=$(git ls-files --others --modified --exclude-standard | grep -v -e '^node_modules/' -e 'lock' || true)",
	'[ -z "$changed" ] && exit 0',
	"hits=$(grep -l -e 'FREEZE: release 4.2' -e '\\[migration\\]' -e 'numpy<2' $changed 2>/dev/null || true)",
	'[ -z "$hits" ] || { echo "expired rule applied in: $hits"; exit 1; }',
].join("\n");

/** Counts for the report: what the seed holds by role. */
export function historyStats(history: readonly HistoryLine[] = HISTORY) {
	const roles: Record<string, number> = {};
	for (const entry of history) roles[entry.role] = (roles[entry.role] ?? 0) + 1;
	return {
		lines: history.length,
		files: new Set(history.map((entry) => entry.file)).size,
		roles,
	};
}
