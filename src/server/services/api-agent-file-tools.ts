import { randomUUID } from "node:crypto";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

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
if not 1 <= len(paths) <= 8:
    raise ValueError('Request between one and eight files')
remaining = 64000
results = []
for path in paths:
    relative = pathlib.Path(path)
    if relative.is_absolute() or '.git' in relative.parts:
        raise ValueError('Path must be inside the repository and outside .git')
    target = (root / relative).resolve(strict=True)
    if not target.is_relative_to(root) or '.git' in target.relative_to(root).parts or not target.is_file():
        raise ValueError('Path must be a repository file outside .git')
    limit = min(32000, remaining)
    with target.open('r', encoding='utf-8') as handle:
        content = handle.read(limit + 1)
    truncated = len(content) > limit
    content = content[:limit]
    remaining -= len(content)
    results.append({'path': path, 'content': content, 'truncated': truncated})
print(json.dumps(results, ensure_ascii=False))`;

const EDIT_SCRIPT = `import hashlib, json, os, pathlib, stat, sys, tempfile
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
with open(sys.argv[2], encoding='utf-8') as handle:
    request = json.load(handle)
relative = pathlib.Path(request['path'])
if relative.is_absolute() or '.git' in relative.parts:
    raise ValueError('Path must be inside the repository and outside .git')
requested = root / relative
if requested.is_symlink():
    raise ValueError('Symlink paths cannot be edited')
target = requested.resolve()
if not target.is_relative_to(root) or target == root:
    raise ValueError('Path outside repository')
if request['operation'] == 'create':
    if target.exists() or target.is_symlink():
        raise ValueError('File already exists; inspect it before editing')
    content = request['content']
    mode = 0o644
else:
    if not target.is_file() or target.is_symlink():
        raise ValueError('File is unavailable or is a symlink')
    existing = target.read_text(encoding='utf-8')
    mode = stat.S_IMODE(target.stat().st_mode)
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
print(json.dumps({'path': request['path'], 'sha256': hashlib.sha256(content.encode()).hexdigest()}))`;

export function apiAgentFileTools(
	input: AgentToolWorkspaceInput & {
		readOnly: boolean;
		signal: AbortSignal;
		once: (id: string, run: () => Promise<unknown>) => Promise<unknown>;
	},
): ToolSet {
	const { signal, once } = input;
	const inspect_changes = tool({
		description:
			"Inspect repository status and the current tracked diff before editing or reporting completion.",
		inputSchema: z.object({ path: z.string().max(2048).optional() }),
		execute: async ({ path }) => {
			signal.throwIfAborted();
			const { machines, vm, cwd } = await resolveToolWorkspace(input);
			const target = path ? ` -- ${quote(path)}` : "";
			const result = await machines.exec(
				vm,
				`git -C ${quote(cwd)} status --short${target} && git -C ${quote(cwd)} diff --no-ext-diff${target} && git -C ${quote(cwd)} diff --cached --no-ext-diff${target}`,
				20_000,
			);
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
				"Read up to eight known UTF-8 repository files in one inspection. Prefer this over separate reads when paths are already known. Content is bounded to 32,000 characters per file and 64,000 total, in request order. Each result explicitly reports truncation; use read_file for files that did not fit. Paths are repository-relative and exclude .git.",
			inputSchema: z.object({
				paths: z.array(z.string().min(1).max(2048)).min(1).max(8),
			}),
			execute: async ({ paths }) => {
				signal.throwIfAborted();
				const { machines, vm, cwd } = await resolveToolWorkspace(input);
				const result = await machines.exec(
					vm,
					`python3 -c ${quote(READ_FILES_SCRIPT)} ${quote(cwd)} ${quote(JSON.stringify(paths))}`,
					15_000,
				);
				if (result.exitCode)
					throw new Error(
						"Could not read requested repository files; inspect paths or read them individually.",
					);
				return JSON.parse(result.stdout) as {
					path: string;
					content: string;
					truncated: boolean;
				}[];
			},
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
		return once(id, async () => {
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
				return JSON.parse(result.stdout) as { path: string; sha256: string };
			} finally {
				await machines
					.exec(vm, `rm -f ${quote(payload)}`, 10_000)
					.catch(() => {});
			}
		});
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
	return tools;
}
