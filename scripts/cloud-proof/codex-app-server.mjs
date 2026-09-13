import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";

const workspace = "/home/ubuntu/ytimesy-proof";
const executable = "/home/ubuntu/ytimesy-agent/node_modules/.bin/codex";
const expectedContent = "ytimesy cloud proof\n";
const pending = new Map();
let nextId = 0;
let completeTurn;
let failTurn;
const turnCompletion = new Promise((resolve, reject) => {
	completeTurn = resolve;
	failTurn = reject;
});
// Attach immediately: a process failure can precede the turn/completed wait.
turnCompletion.catch(() => {});

await mkdir(workspace, { recursive: true });
await rm(`${workspace}/proof.txt`, { force: true });
const child = spawn(executable, ["app-server"], {
	cwd: workspace,
	stdio: ["pipe", "pipe", "ignore"],
});
const timeout = setTimeout(() => {
	failPending(new Error("App-server proof exceeded 120 seconds"));
	child.kill("SIGKILL");
}, 120_000);

function failPending(error) {
	for (const request of pending.values()) request.reject(error);
	pending.clear();
	failTurn(error);
}

function send(message) {
	child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
	const id = ++nextId;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		send({ id, method, params });
	});
}

child.on("error", failPending);
child.on("exit", () => failPending(new Error("App-server exited")));
createInterface({ input: child.stdout }).on("line", (line) => {
	try {
		const message = JSON.parse(line);
		if (message.id !== undefined && !message.method) {
			const deferred = pending.get(message.id);
			if (!deferred) return;
			pending.delete(message.id);
			if (message.error) deferred.reject(new Error(message.error.message));
			else deferred.resolve(message.result);
		} else if (message.id !== undefined) {
			// This bounded smoke test never approves unexpected tools or permissions.
			send({
				id: message.id,
				error: { code: -32601, message: "Not supported by smoke test" },
			});
		} else if (message.method === "turn/completed") {
			completeTurn(message.params.turn);
		}
	} catch (error) {
		failPending(error);
	}
});

try {
	await request("initialize", {
		clientInfo: { name: "ytimesy-proof", version: "0.1.0" },
	});
	send({ method: "initialized" });
	const { account } = await request("account/read", { refreshToken: false });
	if (account?.type !== "chatgpt")
		throw new Error("ChatGPT subscription login required; no API fallback");
	const { data: models } = await request("model/list", {});
	const model = models.find((candidate) => candidate.isDefault) ?? models[0];
	if (!model) throw new Error("No model is available for this account");
	console.log(
		JSON.stringify({
			stage: "authenticated",
			authentication: account.type,
			model: model.model,
		}),
	);
	const { thread } = await request("thread/start", {
		cwd: workspace,
		model: model.model,
		approvalPolicy: "never",
		sandbox: "workspace-write",
	});
	await request("turn/start", {
		threadId: thread.id,
		input: [
			{
				type: "text",
				text: 'Create a file named proof.txt in the current directory containing exactly "ytimesy cloud proof" followed by a newline. Do not modify any other files or use the network.',
				text_elements: [],
			},
		],
	});
	const turn = await turnCompletion;
	if (turn.status !== "completed")
		throw new Error(`Agent turn ended with status ${turn.status}`);
	const content = await readFile(`${workspace}/proof.txt`, "utf8");
	if (content !== expectedContent)
		throw new Error("Agent output failed the file-content check");
	console.log(
		JSON.stringify({
			stage: "verified",
			threadId: thread.id,
			turnId: turn.id,
			file: "proof.txt",
		}),
	);
} catch (error) {
	console.error(JSON.stringify({ stage: "failed", message: error.message }));
	process.exitCode = 1;
} finally {
	clearTimeout(timeout);
	child.stdin.end();
	child.kill("SIGTERM");
}
