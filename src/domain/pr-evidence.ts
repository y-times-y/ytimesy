import { z } from "zod";

/**
 * Pull request evidence (harness variant prEvidence=on): screenshots, a short
 * screen recording or CLI output that the harness itself captures from the
 * pushed commit, stored durably and shown in an "Evidence" section of the
 * pull request description. The builder only proposes how to show its change
 * (a capture plan); everything shown in the pull request is produced by the
 * harness-run capture, never by files the model made.
 */

export const EVIDENCE_LIMITS = {
	urls: 6,
	flowSteps: 20,
	stepTimeoutMs: 10_000,
	waitMs: 5_000,
	startSeconds: { default: 90, max: 180 },
	cliSeconds: 60,
	cliOutputChars: 6_000,
	screenshots: 8,
	screenshotBytes: 3 * 1024 * 1024,
	videoSeconds: 45,
	videoBytes: 8 * 1024 * 1024,
	/** The whole capture in the workspace, tooling install included. */
	captureSeconds: 300,
	startCommandChars: 500,
} as const;

const localUrl = z
	.string()
	.max(2048)
	.refine((value) => {
		if (value.startsWith("/")) return !value.startsWith("//");
		try {
			const url = new URL(value);
			return (
				(url.protocol === "http:" || url.protocol === "https:") &&
				!url.username &&
				!url.password &&
				["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname)
			);
		} catch {
			return false;
		}
	}, "Evidence pages are the app running in the workspace: a localhost URL or a path such as /settings.");

const selector = z.string().min(1).max(500);
export const evidenceFlowStep = z.discriminatedUnion("action", [
	z.object({ action: z.literal("goto"), url: localUrl }),
	z.object({ action: z.literal("click"), selector }),
	z.object({
		action: z.literal("fill"),
		selector,
		text: z.string().max(500),
	}),
	z.object({
		action: z.literal("press"),
		key: z.string().min(1).max(40),
		selector: selector.optional(),
	}),
	z.object({
		action: z.literal("wait"),
		ms: z.number().int().min(0).max(EVIDENCE_LIMITS.waitMs),
	}),
	z.object({ action: z.literal("waitFor"), selector }),
	z.object({
		action: z.literal("screenshot"),
		name: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]{0,30}$/)
			.optional(),
	}),
]);
export type EvidenceFlowStep = z.infer<typeof evidenceFlowStep>;

const command = z
	.string()
	.trim()
	.min(1)
	.max(EVIDENCE_LIMITS.startCommandChars)
	.refine((value) => !/[\r\n\0]/.test(value), "One line only.");

/** The builder's capture plan (`ytimesy-evidence capture`), saved in the workspace. */
export const evidenceRequest = z.discriminatedUnion("mode", [
	z.object({
		version: z.literal(1),
		mode: z.literal("web"),
		start: command,
		urls: z.array(localUrl).min(1).max(EVIDENCE_LIMITS.urls),
		flow: z.array(evidenceFlowStep).max(EVIDENCE_LIMITS.flowSteps).default([]),
		startSeconds: z
			.number()
			.int()
			.min(5)
			.max(EVIDENCE_LIMITS.startSeconds.max)
			.default(EVIDENCE_LIMITS.startSeconds.default),
	}),
	z.object({
		version: z.literal(1),
		mode: z.literal("cli"),
		command,
	}),
]);
export type EvidenceRequest = z.infer<typeof evidenceRequest>;

/** Without a plan, a UI change in a package with a dev script is started with it. */
export type EvidencePlan = EvidenceRequest | { version: 1; mode: "auto" };

export function evidenceRequestFromText(text: string | null) {
	if (!text?.trim()) return null;
	try {
		const parsed = evidenceRequest.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

const VISIBLE_EXTENSIONS =
	/\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|styl|mdx|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i;
const VISIBLE_DIRECTORIES =
	/(^|\/)(components?|pages|app|routes|views|layouts|templates|public|static|styles|ui|features|screens|widgets)\//i;
const NOT_VISIBLE =
	/(^|\/)(__tests__|tests?|spec|e2e|fixtures|__snapshots__|stories|\.github|docs?)\/|\.(test|spec|stories)\.[a-z]+$|\.d\.ts$/i;

/** Whether a changed path can change what a user sees in the running app. */
export function visiblePath(path: string) {
	if (NOT_VISIBLE.test(path)) return false;
	if (VISIBLE_EXTENSIONS.test(path)) return true;
	return (
		VISIBLE_DIRECTORIES.test(path) && /\.(ts|js|mjs|cjs|json)$/i.test(path)
	);
}

export function visibleChanges(paths: readonly string[]) {
	return paths.filter(visiblePath);
}

/**
 * Whether this handoff captures evidence: an explicit plan always (the
 * builder asked for it), otherwise only a diff that touches visible files.
 */
export function evidencePlanFor(input: {
	request: EvidenceRequest | null;
	changedPaths: readonly string[];
}): EvidencePlan | null {
	if (input.request) return input.request;
	return visibleChanges(input.changedPaths).length
		? { version: 1, mode: "auto" }
		: null;
}

/** A short identity of the plan, so a re-push of the same commit with the same plan does not recapture. */
export function evidencePlanKey(plan: EvidencePlan, sha256Hex: string) {
	return `${plan.mode}-${sha256Hex.slice(0, 12)}`;
}

const sha = z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/);
const fileName = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,40}\.(png|webm|txt|json)$/);
const isoTime = z.string().max(40);

export const evidenceManifest = z.object({
	version: z.literal(1),
	mode: z.enum(["verify", "preview"]),
	kind: z.enum(["web", "cli"]),
	status: z.enum(["captured", "app-failed", "dirty", "tooling-failed"]),
	reason: z.string().max(600).default(""),
	sha: sha.or(z.literal("")),
	clean: z.boolean(),
	startCommand: z.string().max(EVIDENCE_LIMITS.startCommandChars).default(""),
	startSource: z.enum(["plan", "auto", "cli"]),
	urls: z.array(z.string().max(2048)).max(EVIDENCE_LIMITS.urls).default([]),
	pages: z
		.array(
			z.object({
				url: z.string().max(2048),
				status: z.number().int().nullable(),
				title: z.string().max(300).default(""),
				screenshot: fileName.nullable(),
				error: z.string().max(400).default(""),
			}),
		)
		.max(EVIDENCE_LIMITS.urls)
		.default([]),
	flow: z
		.array(
			z.object({
				step: z.string().max(600),
				ok: z.boolean(),
				error: z.string().max(400).default(""),
				screenshot: fileName.nullable().default(null),
			}),
		)
		.max(EVIDENCE_LIMITS.flowSteps)
		.default([]),
	video: z
		.object({ file: fileName, seconds: z.number().min(0) })
		.nullable()
		.default(null),
	cli: z
		.object({
			command: z.string().max(EVIDENCE_LIMITS.startCommandChars),
			exitCode: z.number().int().nullable(),
			file: fileName,
		})
		.nullable()
		.default(null),
	files: z
		.array(
			z.object({
				name: fileName,
				bytes: z.number().int().min(0),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
			}),
		)
		.max(EVIDENCE_LIMITS.screenshots + 3)
		.default([]),
	dropped: z.array(z.string().max(200)).max(20).default([]),
	browser: z.string().max(120).default(""),
	viewport: z.string().max(20).default(""),
	startedAt: isoTime,
	appReadyAt: isoTime.default(""),
	finishedAt: isoTime,
});
export type EvidenceManifest = z.infer<typeof evidenceManifest>;

export const EVIDENCE_KEY_PREFIX = "pr-evidence/";

const evidenceId = /^[a-f0-9]{32}$/;

/** The storage key of one evidence file; only ids and file names this module accepts reach storage. */
export function evidenceObjectKey(id: string, name: string) {
	if (!evidenceId.test(id) || !fileName.safeParse(name).success)
		throw new Error("Invalid evidence object.");
	return `${EVIDENCE_KEY_PREFIX}${id}/${name}`;
}

/** A served path `<id>/<name>`, or null for anything else (including other storage). */
export function evidencePathFromRequest(path: string) {
	const match =
		/^([a-f0-9]{32})\/([a-z0-9][a-z0-9-]{0,40}\.(png|webm|txt|json))$/.exec(
			path,
		);
	if (!match) return null;
	return {
		key: evidenceObjectKey(match[1], match[2]),
		contentType: EVIDENCE_CONTENT_TYPES[match[3] as EvidenceExtension],
	};
}

type EvidenceExtension = "png" | "webm" | "txt" | "json";
export const EVIDENCE_CONTENT_TYPES: Record<EvidenceExtension, string> = {
	png: "image/png",
	webm: "video/webm",
	txt: "text/plain; charset=utf-8",
	json: "text/plain; charset=utf-8",
};

export function evidenceContentType(name: string) {
	const extension = name.split(".").pop() as EvidenceExtension;
	return EVIDENCE_CONTENT_TYPES[extension] ?? null;
}

/** Bytes a manifest may name, by kind; anything above was dropped in the workspace or is refused. */
export function evidenceFileLimit(name: string) {
	if (name.endsWith(".webm")) return EVIDENCE_LIMITS.videoBytes;
	if (name.endsWith(".png")) return EVIDENCE_LIMITS.screenshotBytes;
	return 256 * 1024;
}

export const EVIDENCE_START = "<!-- ytimesy-evidence:start";
export const EVIDENCE_END = "<!-- ytimesy-evidence:end -->";

/** What the current section says it shows, to skip recapturing an unchanged commit and plan. */
export function evidenceSectionState(body: string | null | undefined) {
	const match =
		/<!-- ytimesy-evidence:start sha=([a-f0-9]{0,64}) plan=([a-z0-9-]{0,40}) -->/.exec(
			body ?? "",
		);
	return match ? { sha: match[1], plan: match[2] } : null;
}

/** Replaces the evidence section, or appends one; the rest of the description is kept. */
export function withEvidenceSection(
	body: string | null | undefined,
	section: string,
) {
	const current = body ?? "";
	const start = current.indexOf(EVIDENCE_START);
	const end = current.indexOf(EVIDENCE_END, start);
	if (start >= 0 && end > start)
		return `${current.slice(0, start)}${section}${current.slice(end + EVIDENCE_END.length)}`;
	return current.trim() ? `${current.trimEnd()}\n\n${section}` : section;
}

/** Inline code that stays one span whatever the text holds. */
function code(text: string, max = 300) {
	const clean = text.replace(/[\r\n]+/g, " ").slice(0, max);
	const longest = Math.max(
		0,
		...[...clean.matchAll(/`+/g)].map((run) => run[0].length),
	);
	const fence = "`".repeat(longest + 1);
	const pad = clean.startsWith("`") || clean.endsWith("`") ? " " : "";
	return `${fence}${pad}${clean}${pad}${fence}`;
}

function plain(text: string, max = 300) {
	return text
		.replace(/[\r\n]+/g, " ")
		.replace(/[<>[\]()*_`|\\]/g, (character) => `\\${character}`)
		.slice(0, max);
}

function megabytes(bytes: number) {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type RenderedEvidence = {
	manifest: EvidenceManifest;
	/** Public URL of each stored file, by file name. */
	links: Record<string, string>;
	manifestUrl: string | null;
	planKey: string;
	/** The pull request head the commit was checked against. */
	headSha: string;
	cliOutput?: string;
};

const FAILURE_LEAD: Record<
	Exclude<EvidenceManifest["status"], "captured">,
	string
> = {
	"app-failed": "The app did not start",
	dirty: "The workspace checkout did not match the pushed commit",
	"tooling-failed": "The capture tooling could not run",
};

/** The pull request's Evidence section: what was captured, from which commit, and how. */
export function renderEvidenceSection(input: RenderedEvidence) {
	const { manifest, links } = input;
	const short = manifest.sha.slice(0, 7) || "unknown";
	const lines = [
		`${EVIDENCE_START} sha=${manifest.sha} plan=${input.planKey} -->`,
		"## Evidence",
		"",
	];
	if (manifest.status !== "captured") {
		lines.push(
			`${FAILURE_LEAD[manifest.status]} at commit \`${short}\`, so this pull request shows no screenshots or recording${manifest.reason ? `: ${plain(manifest.reason, 400)}` : "."}`,
		);
		if (manifest.startCommand)
			lines.push("", `Start command: ${code(manifest.startCommand)}`);
		lines.push(
			"",
			`<sub>Checked by the ytimesy harness at ${plain(manifest.finishedAt, 40)}. Earlier evidence, if any, was removed because it would not show this commit.</sub>`,
			EVIDENCE_END,
		);
		return lines.join("\n");
	}
	const verified =
		manifest.clean && manifest.sha === input.headSha
			? `a clean checkout of commit \`${short}\`, the pull request head`
			: `commit \`${short}\``;
	lines.push(`Captured by the ytimesy harness from ${verified}.`, "");
	if (manifest.kind === "cli" && manifest.cli) {
		lines.push(
			`${code(manifest.cli.command)} exited ${manifest.cli.exitCode ?? "without a status (timed out)"}:`,
			"",
			"```text",
			(input.cliOutput ?? "").replaceAll("```", "``​`"),
			"```",
		);
	}
	for (const page of manifest.pages) {
		const link = page.screenshot ? links[page.screenshot] : undefined;
		lines.push(
			`**${code(page.url, 200)}**${page.status === null ? "" : ` (HTTP ${page.status})`}${page.error ? `: ${plain(page.error, 200)}` : ""}`,
		);
		if (link)
			lines.push("", `![${plain(page.title || page.url, 80)}](${link})`);
		lines.push("");
	}
	const flowShots = manifest.flow.filter(
		(step) => step.screenshot && links[step.screenshot],
	);
	for (const step of flowShots)
		lines.push(
			`After ${code(step.step, 120)}:`,
			"",
			`![flow](${links[step.screenshot as string]})`,
			"",
		);
	const video = manifest.video;
	const videoFile = video
		? manifest.files.find((file) => file.name === video.file)
		: undefined;
	if (video && links[video.file])
		lines.push(
			`[Screen recording](${links[video.file]}) (WebM, ${Math.round(video.seconds)} s${videoFile ? `, ${megabytes(videoFile.bytes)}` : ""})`,
			"",
		);
	const failedSteps = manifest.flow.filter((step) => !step.ok);
	const details = [
		`- Commit: \`${manifest.sha}\`${manifest.clean ? " (working tree identical to the commit)" : ""}`,
		manifest.startCommand
			? `- Start command: ${code(manifest.startCommand)} (${manifest.startSource === "auto" ? "detected from package.json" : "from the builder's capture plan"})`
			: "",
		manifest.urls.length
			? `- Pages visited: ${manifest.urls.map((url) => code(url, 200)).join(", ")}`
			: "",
		manifest.flow.length
			? `- Flow: ${manifest.flow.length} step${manifest.flow.length === 1 ? "" : "s"}${failedSteps.length ? `, ${failedSteps.length} failed (${failedSteps.map((step) => `${code(step.step, 80)}: ${plain(step.error, 120)}`).join("; ")})` : ", all passed"}`
			: "",
		`- Captured ${plain(manifest.startedAt, 40)} to ${plain(manifest.finishedAt, 40)} (workspace clock)${manifest.appReadyAt ? `, app answered at ${plain(manifest.appReadyAt, 40)}` : ""}`,
		manifest.browser
			? `- Browser: ${plain(manifest.browser, 120)}${manifest.viewport ? `, viewport ${plain(manifest.viewport, 20)}` : ""}`
			: "",
		manifest.dropped.length
			? `- Left out (over size or time limits): ${manifest.dropped.map((item) => plain(item, 120)).join("; ")}`
			: "",
		input.manifestUrl
			? `- [Manifest](${input.manifestUrl}) with the SHA-256 of every file`
			: "",
	].filter(Boolean);
	lines.push(
		"<details><summary>How this was produced</summary>",
		"",
		...details,
		"",
		"</details>",
		EVIDENCE_END,
	);
	return lines.join("\n");
}
