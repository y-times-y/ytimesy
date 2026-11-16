import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	agentSecretsEnvFile,
	REDACTED,
	redactSecretValues,
	secretForms,
} from "./project-secret";
import {
	unwrapVmRedaction,
	VM_REDACTION_FAILED,
	vmRedactedCommand,
	vmRedactionProbe,
	vmRedactionReady,
} from "./vm-secret-redaction";

/** The VM, played by this machine's bash and python3. */
const directory = mkdtempSync(join(tmpdir(), "vm-redaction-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function envFile(
	secrets: readonly {
		name: string;
		value: string;
		kind: "runtime" | "environment";
	}[],
) {
	const path = join(
		directory,
		`agent-${Math.random().toString(36).slice(2)}.env`,
	);
	writeFileSync(path, agentSecretsEnvFile(secrets), { mode: 0o600 });
	return path;
}

function onVm(command: string, stdin?: string) {
	const ran = spawnSync("bash", ["-c", command], {
		input: stdin ?? "",
		encoding: "utf8",
	});
	return { exitCode: ran.status ?? -1, stdout: ran.stdout, stderr: ran.stderr };
}

/** Prints `text` on the VM (stdout, then the same on stderr) through the filter. */
function redactedOnVm(text: string, envPath: string) {
	const encoded = Buffer.from(text, "utf8").toString("base64");
	const ran = onVm(
		vmRedactedCommand(
			`printf %s '${encoded}' | base64 -d; printf %s '${encoded}' | base64 -d >&2`,
			envPath,
		),
	);
	const unwrapped = unwrapVmRedaction(ran.stderr);
	if (!unwrapped) throw new Error(`no marker: ${ran.stderr}`);
	return { ...ran, stderr: unwrapped.stderr, replaced: unwrapped.replaced };
}

const RUNTIME = [
	{ name: "API_KEY", value: "sk-live-0123456789abcdef", kind: "runtime" },
	{ name: "DB_URL", value: "postgres://u:p@db/x?ssl=1&a=b c", kind: "runtime" },
	{ name: "QUOTED", value: `pa"ss\\word'é€😀`, kind: "runtime" },
	{ name: "SHORT", value: "abc123", kind: "runtime" },
	{ name: "PLAIN", value: "not-a-secret-value", kind: "environment" },
] as const;
const VALUES = RUNTIME.filter((secret) => secret.kind === "runtime").map(
	(secret) => secret.value,
);

/** Outputs a command might print: each value as written and in every encoding the edge matches. */
function sampleOutputs() {
	const samples = [
		"nothing secret here\n",
		`export API_KEY=${VALUES[0]}\nAPI_KEY again: ${VALUES[0]}${VALUES[0]}\n`,
		`curl ${VALUES[1]} failed`,
		`config: {"password": ${JSON.stringify(VALUES[2])}}`,
		`short ${VALUES[3]} and abc12 and not-a-secret-value`,
		`${VALUES[2]} unicode in place`,
		"bytes: \u0000\u0001 tab\t end",
	];
	for (const value of VALUES)
		for (const form of secretForms(value))
			samples.push(`before ${form} after\n`, `x${form}`, form);
	// Base64 of the value inside a larger blob, at each byte alignment.
	for (const value of VALUES)
		for (const prefix of ["", "a", "ab", "abc"])
			samples.push(Buffer.from(`${prefix}${value}tail`).toString("base64"));
	return samples;
}

describe("redacting runtime secrets on the VM", () => {
	const path = envFile([...RUNTIME]);

	it("gives the same text as the edge's redaction for every sample output", () => {
		// One VM run for all samples; no form holds the separator, so none spans two.
		const separator = "\n\u0001\n";
		const samples = sampleOutputs();
		const vm = redactedOnVm(samples.join(separator), path);
		expect(vm.exitCode).toBe(0);
		const out = vm.stdout.split(separator);
		const err = vm.stderr.split(separator);
		expect(out).toHaveLength(samples.length);
		samples.forEach((sample, index) => {
			const edge = redactSecretValues(sample, VALUES);
			expect({ sample, out: out[index] }).toEqual({ sample, out: edge });
			expect({ sample, err: err[index] }).toEqual({ sample, err: edge });
		});
		expect(vm.stdout).not.toContain(VALUES[0]);
	});

	it("counts replacements and leaves environment variables alone", () => {
		const vm = redactedOnVm(`${VALUES[0]} not-a-secret-value`, path);
		expect(vm.stdout).toBe(`${REDACTED} not-a-secret-value`);
		expect(vm.replaced).toBe(2);
		expect(redactedOnVm("clean", path).replaced).toBe(0);
	});

	it("also catches values inside JSON the VM's tool helpers print", () => {
		// The read helper prints JSON with ASCII escapes; the edge would decode it first.
		const printed = JSON.stringify({ text: `k=${VALUES[2]}` }).replace(
			/[\u007f-￿]/g,
			(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
		const vm = redactedOnVm(printed, path);
		expect(JSON.parse(vm.stdout)).toEqual({ text: `k=${REDACTED}` });
	});

	it("keeps the command's exit status, stdin and stdout/stderr split", () => {
		const ran = onVm(
			vmRedactedCommand(
				`read -r line; echo "$line $API_KEY"; echo oops >&2\nexit 7`,
				path,
			),
			`hello ${VALUES[0]}\n`,
		);
		expect(ran.exitCode).toBe(7);
		expect(ran.stdout).toBe(`hello ${REDACTED} \n`);
		expect(unwrapVmRedaction(ran.stderr)).toEqual({
			stderr: "oops\n",
			replaced: 1,
		});
	});

	it("drops the output, status 125, when the env file is missing", () => {
		const ran = onVm(
			vmRedactedCommand(`echo ${VALUES[0]}`, join(directory, "missing.env")),
		);
		expect(ran.exitCode).toBe(125);
		expect(ran.stdout).toBe("");
		expect(ran.stderr).toContain(VM_REDACTION_FAILED);
		expect(ran.stderr).not.toContain(VALUES[0]);
		expect(unwrapVmRedaction(ran.stderr)).toBeNull();
	});

	it("does not trust output without the filter's final marker", () => {
		expect(unwrapVmRedaction("plain stderr")).toBeNull();
		expect(
			unwrapVmRedaction("x\nytimesy-vm-redaction:3\nmore after"),
		).toBeNull();
	});
});

describe("whether the VM can redact a turn's secrets", () => {
	it("is ready with an env file naming runtime secrets", () => {
		const probe = onVm(vmRedactionProbe(envFile([...RUNTIME])));
		expect(vmRedactionReady(probe)).toBe(true);
		expect(probe.stdout + probe.stderr).not.toContain(VALUES[0]);
	});

	it("is not ready without the file, or when it names no runtime secret (an older or other turn's file)", () => {
		expect(
			vmRedactionReady(onVm(vmRedactionProbe(join(directory, "none.env")))),
		).toBe(false);
		expect(
			vmRedactionReady(
				onVm(
					vmRedactionProbe(
						envFile([
							{ name: "PLAIN", value: "abcdefgh", kind: "environment" },
						]),
					),
				),
			),
		).toBe(false);
	});
});
