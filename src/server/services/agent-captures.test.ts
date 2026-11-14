import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvidenceRecord } from "#/domain/pr-evidence";
import {
	AGENT_CAPTURES_SCRIPT,
	agentCaptureId,
	agentCapturesNote,
	agentCapturesPullRequestSection,
	collectAgentCaptures,
} from "./agent-captures";
import { leanHelperBundle, recordCommand } from "./lean-helpers";

const SESSION = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";

let root: string;
const realPython = execFileSync("bash", ["-c", "command -v python3"])
	.toString()
	.trim();

function run(command: string, args: string[], env: Record<string, string>) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
		execFile(command, args, { env }, (error, stdout, stderr) =>
			done({
				code: error ? Number(error.code ?? 1) : 0,
				stdout,
				stderr,
			}),
		),
	);
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "agent-captures-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	await mkdir(join(root, "home"));
	const stubs: Record<string, string> = {
		// The desktop is already up (its port check).
		python3: "exit 0",
		scrot: `printf PNG >"\${@: -1}"`,
		xdpyinfo: "echo '  dimensions:    1440x900 pixels'",
		ffmpeg: `printf '%s\\n' "$@" >"${root}/ffmpeg.args"; printf MP4 >"\${@: -1}"`,
	};
	for (const [name, body] of Object.entries(stubs)) {
		await writeFile(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
		await chmod(join(bin, name), 0o755);
	}
	const script = leanHelperBundle(SESSION).files["bin/ytimesy-browser"].content;
	await writeFile(join(bin, "ytimesy-browser"), script);
	await chmod(join(bin, "ytimesy-browser"), 0o755);
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("ytimesy-browser screenshot and record", () => {
	const env = () => ({
		PATH: `${join(root, "bin")}:${process.env.PATH}`,
		HOME: join(root, "home"),
	});

	it("records the desktop display with ffmpeg x11grab to MP4", () => {
		const command = recordCommand('"$seconds"', '"$format"', '"$file"');
		expect(command).toContain("-f x11grab");
		expect(command).toContain('-i "$DISPLAY"');
		expect(command).toContain('-t "$seconds"');
		expect(command).toContain("-c:v libx264");
		expect(command).toContain("-movflags +faststart");
		expect(command).toContain("-c:v libvpx");
	});

	it("keeps captures outside the repository and registers them for the chat", async () => {
		const shot = await run(
			join(root, "bin", "ytimesy-browser"),
			["screenshot"],
			env(),
		);
		expect(shot.code).toBe(0);
		const shotPath = shot.stdout.trim();
		expect(shotPath).toMatch(
			/\/home\/\.ytimesy\/captures\/screenshot-\d{8}-\d{6}-[0-9a-f]{8}\.png$/,
		);
		const recorded = await run(
			join(root, "bin", "ytimesy-browser"),
			["record", "5"],
			env(),
		);
		expect(recorded.code).toBe(0);
		expect(recorded.stdout.trim()).toMatch(/recording-.*\.mp4$/);
		const args = (await readFile(join(root, "ffmpeg.args"), "utf8")).split(
			"\n",
		);
		expect(args).toEqual(
			expect.arrayContaining(["x11grab", ":0", "5", "1440x900", "libx264"]),
		);
		expect(
			(await run(join(root, "bin", "ytimesy-browser"), ["record", "61"], env()))
				.code,
		).toBe(2);

		const listed = await run(
			realPython,
			["-c", AGENT_CAPTURES_SCRIPT, "list"],
			env(),
		);
		const captures = JSON.parse(listed.stdout) as {
			id: string;
			name: string;
			bytes: number;
			sha256: string;
			seconds: number | null;
		}[];
		expect(captures.map((capture) => [capture.bytes, capture.seconds])).toEqual(
			expect.arrayContaining([
				[3, null],
				[3, 5],
			]),
		);
		expect(captures[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
		await run(
			realPython,
			["-c", AGENT_CAPTURES_SCRIPT, "done", ...captures.map((c) => c.id)],
			env(),
		);
		const after = await run(
			realPython,
			["-c", AGENT_CAPTURES_SCRIPT, "list"],
			env(),
		);
		expect(JSON.parse(after.stdout)).toEqual([]);
	});

	it("copies to a file argument only when one is given", async () => {
		const target = join(root, "repo", "docs", "shot.png");
		const shot = await run(
			join(root, "bin", "ytimesy-browser"),
			["screenshot", target],
			env(),
		);
		expect(shot.stdout.trim()).toBe(target);
		expect(await readFile(target, "utf8")).toBe("PNG");
	});
});

describe("collecting agent captures", () => {
	const png = Buffer.from("png bytes");
	const listing = [
		{
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			name: "screenshot-20261102-120000-0a0b0c0d.png",
			path: "/home/u/.ytimesy/captures/screenshot-20261102-120000-0a0b0c0d.png",
			bytes: png.length,
			sha256: createHash("sha256").update(png).digest("hex"),
			seconds: null,
			capturedAt: "2026-11-02T12:00:00Z",
		},
		{
			id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			name: "recording-20261102-120001-0a0b0c0d.mp4",
			path: "/home/u/.ytimesy/captures/recording-20261102-120001-0a0b0c0d.mp4",
			bytes: 9 * 1024 * 1024,
			sha256: "0".repeat(64),
			seconds: 60,
			capturedAt: "",
		},
	];

	it("stores them as chat evidence at the tool call and forgets them in the workspace", async () => {
		const commands: string[] = [];
		const puts: { key: string; type: string; bytes: number }[] = [];
		const inserts: unknown[] = [];
		const collected = await collectAgentCaptures(
			{
				shell: async (command) => {
					commands.push(command);
					if (command.includes(" list"))
						return { exitCode: 0, stdout: JSON.stringify(listing) };
					if (command.startsWith("dd "))
						return { exitCode: 0, stdout: png.toString("base64") };
					return { exitCode: 0, stdout: "" };
				},
				userId: "user-1",
				projectId: PROJECT,
				sessionId: SESSION,
				itemId: "turn-1:call-7",
			},
			{
				store: () => ({
					put: async (key, body, type) => {
						puts.push({ key, type, bytes: body.length });
					},
					get: async () => new Response(null),
					removePrefix: async () => 0,
				}),
				insert: async (input) => {
					inserts.push(input);
				},
				list: async () => [],
				appUrl: () => undefined,
			},
		);
		const id = agentCaptureId(SESSION, listing[0].id);
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(puts).toEqual([
			{
				key: expect.stringMatching(
					new RegExp(`^pr-evidence/.+/${id}/${listing[0].name}$`),
				),
				type: "image/png",
				bytes: png.length,
			},
		]);
		expect(inserts).toEqual([
			expect.objectContaining({
				id,
				sessionId: SESSION,
				itemId: "turn-1:call-7",
				file: {
					name: listing[0].name,
					bytes: png.length,
					sha256: listing[0].sha256,
				},
				videoSeconds: null,
			}),
		]);
		// Stored and over-limit captures are both forgotten.
		expect(commands.at(-1)).toContain(
			`done '${listing[0].id}' '${listing[1].id}'`,
		);
		const note = agentCapturesNote(collected);
		expect(note).toContain(`Added to the pull request's Evidence section`);
		expect(note).toContain(listing[0].name);
		expect(note).toContain(
			`Not added: ${listing[1].name} (over the 8 MB limit; record fewer seconds).`,
		);
	});

	it("does nothing without evidence storage", async () => {
		const collected = await collectAgentCaptures(
			{
				shell: async () => {
					throw new Error("no workspace call expected");
				},
				userId: "user-1",
				projectId: PROJECT,
				sessionId: SESSION,
				itemId: null,
			},
			{
				store: () => null,
				insert: async () => {},
				list: async () => [],
				appUrl: () => undefined,
			},
		);
		expect(collected).toEqual([]);
		expect(agentCapturesNote(collected)).toBe("");
	});
});

describe("the pull request's Evidence section for agent captures", () => {
	const record = (id: string, name: string, seconds: number | null) =>
		({
			id,
			projectId: PROJECT,
			files: [{ name, bytes: 1, sha256: "0".repeat(64) }],
			videoSeconds: seconds,
		}) as unknown as EvidenceRecord;

	it("counts the chat's captures and links the evidence page", async () => {
		const newest = "33333333-3333-4333-8333-333333333333";
		const section = await agentCapturesPullRequestSection(
			{ userId: "user-1", projectId: PROJECT, sessionId: SESSION },
			{
				store: () => null,
				insert: async () => {},
				list: async () => [
					record(newest, "recording-a.mp4", 5),
					record(
						"44444444-4444-4444-8444-444444444444",
						"screenshot-a.png",
						null,
					),
				],
				appUrl: () => "https://ytimesy.example",
			},
		);
		expect(section).toContain("## Evidence");
		expect(section).toContain(
			"Captured by the agent on its desktop: 1 screenshot, 1 recording (5 s).",
		);
		expect(section).toContain(
			`[View the evidence](https://ytimesy.example/projects/${PROJECT}/evidence/${newest}) in ytimesy (sign-in required).`,
		);
		expect(section).not.toContain("![");
	});

	it("is absent when the chat has no captures", async () => {
		expect(
			await agentCapturesPullRequestSection(
				{ userId: "user-1", projectId: PROJECT, sessionId: SESSION },
				{
					store: () => null,
					insert: async () => {},
					list: async () => [],
					appUrl: () => "https://ytimesy.example",
				},
			),
		).toBeNull();
	});
});
