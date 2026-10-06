import { createHash, randomUUID } from "node:crypto";
import { openai } from "@ai-sdk/openai";
import { applyDiff } from "@openai/agents-core/utils";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { publicToolDetail } from "#/domain/tool-detail";
import type { agentOutputArtifacts } from "./agent-output-artifacts";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import { editDiagnostics } from "./edit-diagnostics";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const patchVerification = z.object({
	formatCommand: z.string().min(1).max(16_000).optional(),
	commands: z.array(z.string().min(1).max(16_000)).min(1).max(8),
	maxSeconds: z.number().int().min(1).max(120).default(120),
});

type RepositoryFileRead = {
	path: string;
	content: string;
	truncated: boolean;
};
type RepositoryFileReadFailure = { path: string; error: "not-a-file" };
type RepositoryFilePage = {
	path: string;
	start: number;
	content: string;
	nextStart: number | null;
};

const READ_ENVIRONMENT_REPORT_SCRIPT = `import json, os, stat, sys
start = int(sys.argv[1])
if not 0 <= start <= 10000000:
    raise ValueError('Report offset is outside the supported range')
try:
    descriptor = os.open('/tmp/ytimesy-environment.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
except FileNotFoundError:
    print(json.dumps({'available': False}))
    sys.exit(0)
with os.fdopen(descriptor, 'r', encoding='utf-8') as handle:
    if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
        raise ValueError('Environment report must be a regular file')
    handle.read(start)
    text = handle.read(32001)
print(json.dumps({'available': True, 'start': start, 'text': text[:32000], 'nextStart': start + 32000 if len(text) > 32000 else None}, ensure_ascii=False))`;

const READ_FILES_SCRIPT = `import json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
paths = json.loads(sys.argv[2])
options = json.loads(sys.argv[3])
page = options['start'] is not None
start = options['start'] if page else 0
maximum = options['maxCharacters']
if not isinstance(maximum, int) or not 1 <= maximum <= 128000:
    raise ValueError('File read size is outside the supported range')
if not 0 <= start <= 10000000 or (page and len(paths) != 1):
    raise ValueError('File page is outside the supported range')
if not 1 <= len(paths) <= 8:
    raise ValueError('Request between one and eight files')
remaining = max(64000, maximum)
results = []
for path in paths:
    relative = pathlib.Path(path)
    if relative.is_absolute() or '.git' in relative.parts:
        raise ValueError('Path must be inside the repository and outside .git')
    target = (root / relative).resolve()
    if not target.is_relative_to(root) or '.git' in target.relative_to(root).parts:
        raise ValueError('Path must be a repository file outside .git')
    if not target.is_file():
        if page:
            raise ValueError('Requested repository file is unavailable')
        results.append({'path': path, 'error': 'not-a-file'})
        continue
    limit = min(maximum, remaining)
    with target.open('r', encoding='utf-8', newline='') as handle:
        handle.read(start)
        content = handle.read(limit + 1)
    truncated = len(content) > limit
    content = content[:limit]
    remaining -= len(content)
    if page:
        results.append({'path': path, 'start': start, 'content': content, 'nextStart': start + len(content) if truncated else None})
    else:
        results.append({'path': path, 'content': content, 'truncated': truncated})
print(json.dumps(results[0] if page else results, ensure_ascii=False))`;

const EDIT_OPERATION_SCRIPT = `
relative = pathlib.Path(request['path'])
if relative.is_absolute() or '.git' in relative.parts:
    raise ValueError('Path must be inside the repository and outside .git')
requested = root / relative
if requested.is_symlink():
    raise ValueError('Symlink paths cannot be edited')
target = requested.resolve()
if not target.is_relative_to(root) or target == root:
    raise ValueError('Path outside repository')
if '.git' in target.relative_to(root).parts:
    raise ValueError('Resolved path must be outside .git')
if request['operation'] == 'create':
    if target.exists() or target.is_symlink():
        raise ValueError('File already exists; inspect it before editing')
    content = request['content']
    mode = 0o644
else:
    if not target.is_file() or target.is_symlink():
        raise ValueError('File is unavailable or is a symlink')
    with target.open('r', encoding='utf-8', newline='') as handle:
        existing = handle.read()
    mode = stat.S_IMODE(target.stat().st_mode)
    if request['operation'] in ('write', 'delete'):
        if hashlib.sha256(existing.encode()).hexdigest() != request['expectedSha256']:
            raise ValueError('File changed since inspection; read the latest file before patching')
        if request['operation'] == 'delete':
            target.unlink()
            return {'path': request['path'], 'deleted': True}
        content = request['content']
    else:
        old = request['old']
        if existing.count(old) != 1:
            raise ValueError('Expected text must occur exactly once; inspect the latest file')
        content = existing.replace(old, request['new'], 1)
target.parent.mkdir(parents=True, exist_ok=True)
if not target.parent.resolve().is_relative_to(root):
    raise ValueError('Parent directory escaped repository')
descriptor, temporary = tempfile.mkstemp(prefix='.ytimesy-edit-', dir=target.parent)
try:
    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
        handle.write(content)
    os.chmod(temporary, mode)
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
return {'path': request['path'], 'sha256': hashlib.sha256(content.encode()).hexdigest(), 'diagnosticSource': content if len(content) <= 32000 else None}`;

const EDIT_SCRIPT = `import fcntl, hashlib, json, os, pathlib, stat, sys, tempfile
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
lock = open('/tmp/ytimesy-edit-lock-' + hashlib.sha256(str(root).encode()).hexdigest(), 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
def apply_edit(request):
${EDIT_OPERATION_SCRIPT.trim()
	.split("\n")
	.map((line) => `    ${line}`)
	.join("\n")}
with open(sys.argv[2], encoding='utf-8') as handle:
    request = json.load(handle)
if isinstance(request, list):
    completed = []
    result = {'completed': completed, 'failedPath': None, 'unattemptedPaths': []}
    for index, operation in enumerate(request):
        try:
            completed.append(apply_edit(operation))
        except Exception as error:
            result.update({'failedPath': operation['path'], 'error': str(error), 'unattemptedPaths': [pending['path'] for pending in request[index + 1:]]})
            break
else:
    result = apply_edit(request)
print(json.dumps(result, ensure_ascii=False))`;

type FileEditReceipt = {
	path: string;
	sha256?: string;
	deleted?: boolean;
	diagnosticSource?: string | null;
};
type BatchEditReceipt = {
	completed: FileEditReceipt[];
	failedPath: string | null;
	unattemptedPaths: string[];
	error?: string;
};

function publicEditReceipt(edited: FileEditReceipt) {
	return {
		path: edited.path,
		...(edited.deleted
			? { deleted: true }
			: {
					sha256: edited.sha256,
					...editDiagnostics(edited.path, edited.diagnosticSource ?? undefined),
				}),
	};
}

export function apiAgentFileTools(
	input: AgentToolWorkspaceInput & {
		readOnly: boolean;
		nativePatch?: boolean;
		output?: ReturnType<typeof agentOutputArtifacts>;
		signal: AbortSignal;
		once: (id: string, run: () => Promise<unknown>) => Promise<unknown>;
		verifyBatch?: (
			request: z.infer<typeof patchVerification>,
			id: string,
		) => Promise<unknown>;
	},
): ToolSet {
	const { signal, once } = input;
	function readRepositoryFiles(
		paths: string[],
		start: undefined,
		maxCharacters?: number,
	): Promise<(RepositoryFileRead | RepositoryFileReadFailure)[]>;
	function readRepositoryFiles(
		paths: string[],
		start: number,
		maxCharacters?: number,
	): Promise<RepositoryFilePage>;
	async function readRepositoryFiles(
		paths: string[],
		start?: number,
		maxCharacters = 32000,
	): Promise<
		(RepositoryFileRead | RepositoryFileReadFailure)[] | RepositoryFilePage
	> {
		signal.throwIfAborted();
		const { machines, vm, cwd } = await resolveToolWorkspace(input);
		const result = await machines.exec(
			vm,
			`python3 -c ${quote(READ_FILES_SCRIPT)} ${quote(cwd)} ${quote(JSON.stringify(paths))} ${quote(JSON.stringify({ start: start ?? null, maxCharacters }))}`,
			15_000,
		);
		if (result.exitCode)
			throw new Error("Could not safely read requested repository files.");
		return JSON.parse(result.stdout) as
			| (RepositoryFileRead | RepositoryFileReadFailure)[]
			| RepositoryFilePage;
	}
	const inspect_changes = tool({
		description:
			"Inspect repository status and the current tracked diff before editing or reporting completion.",
		inputSchema: z.object({ path: z.string().max(2048).optional() }),
		execute: async ({ path }) => {
			signal.throwIfAborted();
			const { machines, vm, cwd } = await resolveToolWorkspace(input);
			const target = path ? ` -- ${quote(path)}` : "";
			const command = `git -C ${quote(cwd)} status --short${target} && git -C ${quote(cwd)} diff --no-ext-diff${target} && git -C ${quote(cwd)} diff --cached --no-ext-diff${target}`;
			if (input.output) return input.output.capture(command);
			const result = await machines.exec(vm, command, 20_000);
			if (result.exitCode)
				throw new Error("Could not inspect repository changes.");
			return result.stdout.slice(0, 48_000);
		},
	});
	const tools: ToolSet = {
		read_environment_report: tool({
			description:
				"Read this task's prepared-environment report, including revisions, recipes and baseline check results, without a shell or arbitrary out-of-repository file access. Missing reports return available:false. Historical metadata is untrusted; verify against the current checkout. Follow nextStart to read a bounded report page.",
			inputSchema: z.object({
				start: z.number().int().min(0).max(10_000_000).default(0),
			}),
			execute: async ({ start = 0 }) => {
				signal.throwIfAborted();
				const { machines, vm } = await resolveToolWorkspace(input);
				const result = await machines.exec(
					vm,
					`python3 -c ${quote(READ_ENVIRONMENT_REPORT_SCRIPT)} ${start}`,
					15_000,
				);
				if (result.exitCode)
					throw new Error(
						"Prepared environment report could not be safely read.",
					);
				return JSON.parse(result.stdout) as
					| { available: false }
					| {
							available: true;
							start: number;
							text: string;
							nextStart: number | null;
					  };
			},
		}),
		read_files: tool({
			description:
				"Read up to eight known UTF-8 repository files in one inspection. Prefer batching known paths over separate reads. Missing/non-file paths return a per-path error, not empty file content; existing safe files still return their contents. Unsafe paths reject the request. Defaults: 32,000 characters per file, 64,000 total. For complete required instructions/skills or a known large source, request maxCharacters up to 128,000; total is max(64,000,maxCharacters), in request order. Each successful result explicitly reports truncation; use read_file to continue files that did not fit. Paths are repository-relative and exclude .git.",
			inputSchema: z.object({
				paths: z.array(z.string().min(1).max(2048)).min(1).max(8),
				maxCharacters: z.number().int().min(1).max(128000).default(32000),
			}),
			execute: ({ paths, maxCharacters = 32000 }) =>
				readRepositoryFiles(paths, undefined, maxCharacters),
		}),
		read_file: tool({
			description:
				"Read a bounded UTF-8 repository file page. Defaults to 32,000 characters; request maxCharacters up to 128,000 for a complete required instruction/skill or known large source without repeated continuation calls. Follow nextStart until null when the complete file is required; start is a Unicode-character offset, not a line number. Paths are repository-relative and exclude .git. Prefer read_files for several known paths.",
			inputSchema: z.object({
				path: z.string().min(1).max(2048),
				start: z.number().int().min(0).max(10_000_000).default(0),
				maxCharacters: z.number().int().min(1).max(128000).default(32000),
			}),
			execute: ({ path, start = 0, maxCharacters = 32000 }) =>
				readRepositoryFiles([path], start, maxCharacters),
		}),
		inspect_changes,
		verify_changes: tool({
			description:
				"Check the repository diff for whitespace errors and report changed files. Run relevant project tests separately before claiming completion.",
			inputSchema: z.object({}),
			execute: async () => {
				signal.throwIfAborted();
				const { machines, vm, cwd } = await resolveToolWorkspace(input);
				const result = await machines.exec(
					vm,
					`git -C ${quote(cwd)} diff --check && git -C ${quote(cwd)} diff --cached --check && git -C ${quote(cwd)} status --short`,
					20_000,
				);
				return {
					passed: result.exitCode === 0,
					output: `${result.stdout}${result.stderr}`.slice(0, 32_000),
				};
			},
		}),
	};
	if (input.readOnly) return tools;
	async function edit(
		id: string,
		request: Record<string, string>,
	): Promise<unknown> {
		return once(id, () => writeEdit(request));
	}
	async function writeEdit(request: Record<string, string>): Promise<unknown> {
		return publicEditReceipt(
			(await writeGuestEdits(request)) as FileEditReceipt,
		);
	}
	async function writeGuestEdits(
		request: Record<string, string> | Record<string, string>[],
	): Promise<FileEditReceipt | BatchEditReceipt> {
		signal.throwIfAborted();
		const { machines, vm, cwd } = await resolveToolWorkspace(input);
		const payload = `/tmp/ytimesy-api-edit-${randomUUID()}.json`;
		await machines.writeTextFile(vm, payload, JSON.stringify(request));
		try {
			const result = await machines.exec(
				vm,
				`python3 -c ${quote(EDIT_SCRIPT)} ${quote(cwd)} ${quote(payload)}`,
				20_000,
			);
			if (result.exitCode)
				throw new Error(result.stderr.slice(-1200) || "Could not edit file.");
			return JSON.parse(result.stdout) as FileEditReceipt | BatchEditReceipt;
		} finally {
			await machines
				.exec(vm, `rm -f ${quote(payload)}`, 10_000)
				.catch(() => {});
		}
	}
	tools.create_file = tool({
		description:
			"Create a new UTF-8 repository file. Fails if it already exists; never overwrites.",
		inputSchema: z.object({
			path: z.string().min(1).max(2048),
			content: z.string().max(100_000),
		}),
		execute: ({ path, content }, options) =>
			edit(options.toolCallId, { operation: "create", path, content }),
	});
	tools.replace_text = tool({
		description:
			"Replace one exact occurrence in an existing UTF-8 repository file. Fails if the file changed or the match is ambiguous.",
		inputSchema: z.object({
			path: z.string().min(1).max(2048),
			old: z.string().min(1).max(16_000),
			new: z.string().max(60_000),
		}),
		execute: ({ path, old, new: replacement }, options) =>
			edit(options.toolCallId, {
				operation: "replace",
				path,
				old,
				new: replacement,
			}),
	});
	const patchOperation = z.discriminatedUnion("type", [
		z.object({
			type: z.literal("create_file"),
			path: z.string().min(1).max(2048),
			diff: z.string().max(100_000),
		}),
		z.object({
			type: z.literal("update_file"),
			path: z.string().min(1).max(2048),
			diff: z.string().max(100_000),
		}),
		z.object({
			type: z.literal("delete_file"),
			path: z.string().min(1).max(2048),
		}),
	]);
	const preparePatch = async (
		operation: z.infer<typeof patchOperation>,
	): Promise<Record<string, string>> => {
		const validated = patchOperation.parse(operation);
		if (validated.type === "create_file") {
			const content = applyDiff("", validated.diff, "create");
			if (content.length > 1_000_000)
				throw new Error("Patch result exceeds the supported file size.");
			return { operation: "create", path: validated.path, content };
		}
		// Read through the same path boundary, then compare-and-swap under the guest edit lock.
		let content = "";
		let start: number | null = 0;
		do {
			const page: RepositoryFilePage = await readRepositoryFiles(
				[validated.path],
				start,
			);
			content += page.content;
			if (content.length > 1_000_000)
				throw new Error("Patch source exceeds the supported file size.");
			start = page.nextStart;
		} while (start !== null);
		const expectedSha256 = createHash("sha256").update(content).digest("hex");
		if (validated.type === "delete_file")
			return {
				operation: "delete",
				path: validated.path,
				expectedSha256,
			};
		const patched = applyDiff(content, validated.diff);
		if (patched.length > 1_000_000)
			throw new Error("Patch result exceeds the supported file size.");
		return {
			operation: "write",
			path: validated.path,
			expectedSha256,
			content: patched,
		};
	};
	const applyPatch = async (operation: z.infer<typeof patchOperation>) =>
		writeEdit(await preparePatch(operation));
	const patchBatch = z
		.array(patchOperation)
		.min(1)
		.max(8)
		.superRefine((operations, context) => {
			const paths = new Set<string>();
			let characters = 0;
			for (const operation of operations) {
				const segments = operation.path.split("/");
				if (
					operation.path.startsWith("/") ||
					operation.path.includes("\\") ||
					operation.path.includes("\0") ||
					segments.some(
						(part) => !part || part === "." || part === ".." || part === ".git",
					) ||
					paths.has(operation.path)
				)
					context.addIssue({
						code: "custom",
						message:
							"Batch paths must be distinct repository-relative files outside .git.",
					});
				paths.add(operation.path);
				characters += "diff" in operation ? operation.diff.length : 0;
			}
			if (characters > 200_000)
				context.addIssue({
					code: "custom",
					message: "Combined patch exceeds the supported batch size.",
				});
		});
	tools.apply_patches = tool({
		description:
			"Apply up to eight distinct files in one call using headerless V4A operations. Parses every diff and reads update sources before writing. Each file uses stale-edit protection. This is not a transaction: on a write failure, reports completed files and stops; inspect that result before retrying. Use for a coherent multi-file implementation instead of separate create_file calls. When all edits and required commands are known, optional verification formats after successful edits, then runs independent checks through run_checks on that stable tree. Formatting failure prevents checks. Do not edit while this call runs; inspect final changes afterward. Completed hashes describe the edit stage, before formatting. Every verification output retains actual exit status and full-output references; failures still require repair and affected checks rerun.",
		inputSchema: z.object({
			operations: patchBatch,
			verification: input.verifyBatch
				? patchVerification.optional()
				: z.never().optional(),
		}),
		execute: ({ operations, verification }, options) =>
			once(options.toolCallId, async () => {
				if (verification && !input.verifyBatch)
					throw new Error(
						"Batch verification is unavailable; no files were changed.",
					);
				const verificationRequest = verification
					? patchVerification.parse(verification)
					: undefined;
				const validated = patchBatch.parse(operations);
				const requests = await Promise.all(validated.map(preparePatch));
				const receipt = (await writeGuestEdits(requests)) as BatchEditReceipt;
				return {
					completed: receipt.completed.map(publicEditReceipt),
					failedPath: receipt.failedPath,
					unattemptedPaths: receipt.unattemptedPaths,
					...(receipt.error ? { error: publicToolDetail(receipt.error) } : {}),
					...(verificationRequest &&
					input.verifyBatch &&
					!receipt.failedPath &&
					!receipt.error &&
					!receipt.unattemptedPaths.length
						? {
								verification: await input.verifyBatch(
									verificationRequest,
									options.toolCallId,
								),
							}
						: {}),
				};
			}),
	});
	tools.apply_patch = input.nativePatch
		? openai.tools.applyPatch({
				execute: async ({ operation }, options) => {
					try {
						return {
							status: "completed" as const,
							output: JSON.stringify(
								await once(options.toolCallId, () => applyPatch(operation)),
							),
						};
					} catch (error) {
						return {
							status: "failed" as const,
							output: publicToolDetail(
								error instanceof Error
									? error.message
									: "Patch failed; inspect the file before retrying.",
							),
						};
					}
				},
			})
		: tool({
				description:
					"Apply one create, update or delete operation using a headerless V4A diff. Update sections use @@ context anchors and space/minus/plus line prefixes. Reads latest content; rejects stale edits, escapes and symlinks. Supply enough context to identify the intended location. Prefer replace_text for small exact replacements.",
				inputSchema: z.object({ operation: patchOperation }),
				execute: ({ operation }, options) =>
					once(options.toolCallId, () => applyPatch(operation)),
			});
	return tools;
}
