import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	DIRECT_DOWNLOAD_SCRIPT,
	DIRECT_UPLOAD_SCRIPT,
	directDownloadCommand,
	directUploadCommand,
	isDirectTranscriptPath,
} from "./direct-transcript";

const hasCurl = spawnSync("curl", ["--version"]).status === 0;
const PATH = "hash/hash/claude-code-abc.direct";

let folder: string;
let server: Server;
let origin: string;
let stored: Buffer | null;
let requests: string[];

beforeEach(async () => {
	folder = mkdtempSync(join(tmpdir(), "ytimesy-direct-"));
	stored = null;
	requests = [];
	server = createServer((request, response) => {
		requests.push(`${request.method} ${request.url}`);
		if (request.method === "PUT") {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				stored = Buffer.concat(chunks);
				response.writeHead(200).end();
			});
			return;
		}
		if (!stored) return void response.writeHead(404).end();
		response.writeHead(200).end(stored);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
	rmSync(folder, { recursive: true, force: true });
});

async function run(script: string, config: object, file: string) {
	const configPath = join(folder, `cfg-${randomBytes(4).toString("hex")}.json`);
	writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
	// Asynchronous: the stand-in R2 server lives in this process and must keep answering.
	const result = await new Promise<{
		status: number | null;
		stdout: string;
		stderr: string;
	}>((resolve) =>
		execFile(
			process.execPath,
			["-e", script, configPath, file],
			{ encoding: "utf8" },
			(error, stdout, stderr) =>
				resolve({
					status: error ? (typeof error.code === "number" ? error.code : 1) : 0,
					stdout,
					stderr,
				}),
		),
	);
	return { result, configPath };
}

const dataKey = randomBytes(32).toString("base64");
const header = "v2.wrapped-key-from-the-server-vault";

it.skipIf(!hasCurl)(
	"encrypts on the VM, uploads with curl, and restores the same bytes",
	async () => {
		const transcript = join(folder, "session.jsonl");
		const original = Buffer.concat([
			Buffer.from('{"type":"user","text":"héllo"}\n'),
			randomBytes(3 * 1024 * 1024 + 17),
		]);
		writeFileSync(transcript, original);
		const upload = await run(
			DIRECT_UPLOAD_SCRIPT,
			{
				url: `${origin}/put?X-Amz-Signature=secret`,
				dataKey,
				path: PATH,
				header,
			},
			transcript,
		);
		expect(upload.result.status, upload.result.stderr).toBe(0);
		expect(upload.result.stdout).toContain("uploaded");
		// The config (URL and key) is deleted, as is the temporary ciphertext.
		expect(existsSync(upload.configPath)).toBe(false);
		expect(existsSync(`${transcript}.direct.tmp`)).toBe(false);
		// What R2 holds is a header plus ciphertext, never the transcript.
		expect(stored?.subarray(0, 10).toString()).toBe("YTDIRECT1\n");
		expect(stored?.includes(Buffer.from("héllo"))).toBe(false);
		expect(stored?.subarray(10, 10 + header.length).toString()).toBe(header);
		expect(stored?.length).toBe(
			10 + header.length + 1 + 12 + original.length + 16,
		);

		const restored = join(folder, "restored.jsonl");
		const download = await run(
			DIRECT_DOWNLOAD_SCRIPT,
			{ url: `${origin}/get?X-Amz-Signature=secret`, dataKey, path: PATH },
			restored,
		);
		expect(download.result.status, download.result.stderr).toBe(0);
		expect(readFileSync(restored).equals(original)).toBe(true);
		expect(existsSync(download.configPath)).toBe(false);
		expect(existsSync(`${restored}.direct.tmp`)).toBe(false);
	},
);

it.skipIf(!hasCurl)(
	"refuses a tampered object, a wrong key or another object path, and writes nothing",
	async () => {
		const transcript = join(folder, "session.jsonl");
		writeFileSync(transcript, randomBytes(4096));
		await run(
			DIRECT_UPLOAD_SCRIPT,
			{ url: `${origin}/put`, dataKey, path: PATH, header },
			transcript,
		);
		const original = Buffer.from(stored as Buffer);
		const attempt = async (config: object, name: string) => {
			const target = join(folder, name);
			const { result } = await run(DIRECT_DOWNLOAD_SCRIPT, config, target);
			return { status: result.status, written: existsSync(target), result };
		};
		const good = { url: `${origin}/get`, dataKey, path: PATH };
		expect((await attempt(good, "ok")).status).toBe(0);
		expect(
			await attempt({ ...good, path: "hash/hash/other.direct" }, "a"),
		).toMatchObject({ status: 1, written: false });
		expect(
			await attempt(
				{ ...good, dataKey: randomBytes(32).toString("base64") },
				"b",
			),
		).toMatchObject({ status: 1, written: false });
		const tampered = Buffer.from(original);
		tampered[tampered.length - 20] ^= 0xff;
		stored = tampered;
		expect(await attempt(good, "c")).toMatchObject({
			status: 1,
			written: false,
		});
	},
);

it.skipIf(!hasCurl)(
	"leaves no signed URL or key in the failure output",
	async () => {
		const transcript = join(folder, "session.jsonl");
		writeFileSync(transcript, "x");
		const secretUrl = `${origin}/missing?X-Amz-Signature=topsecret`;
		const { result } = await run(
			DIRECT_DOWNLOAD_SCRIPT,
			{ url: secretUrl, dataKey, path: PATH },
			join(folder, "out"),
		);
		expect(result.status).toBe(1);
		const output = `${result.stdout}${result.stderr}`;
		expect(output).toContain("direct restore failed");
		expect(output).not.toContain("topsecret");
		expect(output).not.toContain(dataKey);
		const upload = await run(
			DIRECT_UPLOAD_SCRIPT,
			{
				url: "http://127.0.0.1:1/x?X-Amz-Signature=topsecret",
				dataKey,
				path: PATH,
				header,
			},
			transcript,
		);
		const uploadOutput = `${upload.result.stdout}${upload.result.stderr}`;
		expect(upload.result.status).toBe(1);
		expect(uploadOutput).not.toContain("topsecret");
		expect(existsSync(`${transcript}.direct.tmp`)).toBe(false);
	},
);

it("rejects a data key of the wrong length or a header with whitespace before uploading", async () => {
	const transcript = join(folder, "session.jsonl");
	writeFileSync(transcript, "x");
	for (const config of [
		{ url: `${origin}/put`, dataKey: "AAAA", path: PATH, header },
		{ url: `${origin}/put`, dataKey, path: PATH, header: "two words" },
	]) {
		const { result } = await run(DIRECT_UPLOAD_SCRIPT, config, transcript);
		expect(result.status).toBe(1);
	}
	expect(requests).toEqual([]);
});

it("builds shell-quoted commands that run the pinned VM node", () => {
	const upload = directUploadCommand("/h/cfg.json", "/h/a b.jsonl");
	expect(upload.startsWith("/usr/local/bin/node -e '")).toBe(true);
	expect(upload.endsWith(" '/h/cfg.json' '/h/a b.jsonl'")).toBe(true);
	expect(directDownloadCommand("/h/cfg.json", "/h/t.jsonl")).toContain(
		"'/h/t.jsonl'",
	);
	expect(isDirectTranscriptPath("x/claude-code-1.direct")).toBe(true);
	expect(isDirectTranscriptPath("x/claude-code-1.enc")).toBe(false);
	expect(isDirectTranscriptPath(null)).toBe(false);
});
