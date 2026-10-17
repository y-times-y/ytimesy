import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	deliverableCheckCommand,
	deliverableCheckTools,
} from "./deliverable-check";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function workspace(files: Record<string, string>, git = false) {
	const root = mkdtempSync(join(tmpdir(), "deliverable-test-"));
	roots.push(root);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
	if (git) {
		const run = (...args: string[]) =>
			spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
		run("init", "-q");
		run("add", "app.py");
		run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	}
	return root;
}

function check(
	root: string,
	input: Parameters<typeof deliverableCheckCommand>[0],
) {
	const result = spawnSync(
		"bash",
		["-c", deliverableCheckCommand({ ...input, cwd: root })],
		{ cwd: root, encoding: "utf8", env: { ...process.env, PYTHONPATH: root } },
	);
	expect(result.stderr).toBe("");
	return JSON.parse(result.stdout);
}

const READS_DATA = `from pathlib import Path\nprint(Path(__file__).with_name("model.json").read_text())\n`;

describe("check_deliverable", () => {
	it("flags a data file the deliverable needs but does not deliver", () => {
		const root = workspace({ "tool.py": READS_DATA, "model.json": "{}" });
		const report = check(root, {
			files: ["tool.py"],
			tracked: false,
			command: "python3 tool.py",
		});
		expect(report.ok).toBe(false);
		expect(report.problems).toContainEqual(
			expect.objectContaining({ kind: "missing-file", path: "model.json" }),
		);
		expect(report.notDelivered.sample).toContain("model.json");
	});

	it("passes when the data is delivered too", () => {
		const root = workspace({ "tool.py": READS_DATA, "model.json": "{}" });
		const report = check(root, {
			files: ["tool.py", "model.json"],
			tracked: false,
			command: `python3 ${root}/tool.py`,
		});
		expect(report).toMatchObject({ ok: true, exitCode: 0, problems: [] });
		expect(report.stdoutTail.trim()).toBe("{}");
	});

	it("copies tracked files, leaves untracked helpers out and clears PYTHONPATH", () => {
		const root = workspace(
			{ "app.py": "import helper\n", "helper.py": "" },
			true,
		);
		const report = check(root, { command: "python3 app.py" });
		expect(report.ok).toBe(false);
		expect(report.problems).toContainEqual(
			expect.objectContaining({ kind: "missing-module", path: "helper" }),
		);
		expect(report.warnings.join(" ")).toContain("PYTHONPATH");
	});

	it("flags absolute references to undelivered workspace files", () => {
		const root = workspace({ "data/in.txt": "x" });
		writeFileSync(
			join(root, "tool.py"),
			`print(open(${JSON.stringify(`${root}/data/in.txt`)}).read())\n`,
		);
		const report = check(root, {
			files: ["tool.py"],
			tracked: false,
			command: "python3 tool.py",
		});
		expect(report.exitCode).toBe(0);
		expect(report.problems).toContainEqual(
			expect.objectContaining({
				kind: "absolute-reference",
				path: "data/in.txt",
			}),
		);
		const supplied = check(root, {
			files: ["tool.py"],
			inputs: ["data/in.txt"],
			tracked: false,
			command: "python3 tool.py",
		});
		expect(supplied.ok).toBe(true);
	});

	it("reports a time limit and a missing declared file", () => {
		const root = workspace({ "slow.sh": "sleep 5\n" });
		const report = check(root, {
			files: ["slow.sh", "absent.txt"],
			tracked: false,
			command: "bash slow.sh",
			timeoutSeconds: 1,
		});
		expect(report).toMatchObject({ ok: false, timedOut: true });
		expect(report.problems).toContainEqual(
			expect.objectContaining({ kind: "declared-missing", path: "absent.txt" }),
		);
	});

	it("refuses files outside the workspace", () => {
		const root = workspace({});
		const result = spawnSync(
			"bash",
			[
				"-c",
				deliverableCheckCommand({
					files: ["/etc/hosts"],
					command: "true",
					cwd: root,
				}),
			],
			{ cwd: root, encoding: "utf8" },
		);
		expect(result.status).toBe(2);
		expect(JSON.parse(result.stdout).error).toContain("inside the workspace");
	});

	it("runs through execute_command with room for the copy", async () => {
		const executeCommand = vi.fn(async () => ({ status: "completed" }));
		const tools = deliverableCheckTools(executeCommand);
		await tools.check_deliverable.execute?.(
			{ command: "make test", timeoutSeconds: 200 } as never,
			{ toolCallId: "call-1", messages: [] } as never,
		);
		expect(executeCommand).toHaveBeenCalledWith(
			expect.objectContaining({ maxSeconds: 260, yieldSeconds: 30 }),
			expect.objectContaining({ toolCallId: "call-1" }),
		);
		expect(deliverableCheckTools(undefined)).toEqual({});
	});
});
