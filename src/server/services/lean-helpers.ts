import { createHash, randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { browserUseSetup } from "../adapters/browser-use-cli";
import { desktopWallpaperBase64 } from "../adapters/freestyle/desktop-wallpaper";
import { START_WORKSPACE_DESKTOP } from "../adapters/freestyle/start-desktop";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { chromeOpenCommand } from "./api-agent-browser-tools";
import { readableHistory } from "./api-agent-context";
import { BROWSER_INSPECTION_SOURCE } from "./browser-inspection";
import { DELIVERABLE_CHECK_SOURCE } from "./deliverable-check";
import { guestCapabilityCommand } from "./guest-node-capability";

/**
 * What the lean surfaces move out of the tool list and onto the workspace VM
 * (docs/builder-tool-surface.md): `ytimesy-check` (check_deliverable),
 * `ytimesy-browser` (the browser tools), `ytimesy-job` (background command
 * control for shapes without a session tool), `~/.ytimesy/environment.md`
 * (read_environment_report) and `~/.ytimesy/history/` (the context archive
 * tools). Installed when a lean surface first touches the workspace, so no
 * tools-image rebuild is needed.
 */

export const LEAN_HELPER_COMMANDS = [
	"ytimesy-check",
	"ytimesy-browser",
	"ytimesy-job",
] as const;

const CHECK_USAGE =
	"usage: ytimesy-check --files <delivered paths> [--input <paths the user or grader supplies>] [--unprivileged] [--timeout <seconds>] [--keep-env <NAME>...] [--no-tracked] -- <run command>";

/** Parses check_deliverable's arguments from a command line and runs the same check. */
const CHECK_SCRIPT = `#!/usr/bin/env python3
# Runs a deliverable the way a third party would, from a clean copy of what is delivered.
import base64, json, os, shlex, subprocess, sys
USAGE = ${JSON.stringify(CHECK_USAGE)}
CORE = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), 'lib', 'ytimesy-check-core.py')
argv = sys.argv[1:]
if argv[:1] in (['-h'], ['--help']):
    print(USAGE); sys.exit(0)
if '--' not in argv:
    print(USAGE, file=sys.stderr); sys.exit(2)
split = argv.index('--')
options, command = argv[:split], argv[split + 1:]
if not command:
    print(USAGE, file=sys.stderr); sys.exit(2)
args = {'command': command[0] if len(command) == 1 else shlex.join(command), 'files': [], 'inputs': [], 'tracked': True, 'unprivileged': False, 'timeoutSeconds': 120, 'keepEnv': []}
lists = {'--files': 'files', '--file': 'files', '--input': 'inputs', '--inputs': 'inputs', '--keep-env': 'keepEnv'}
current = None
index = 0
while index < len(options):
    option = options[index]
    if option in lists:
        current = lists[option]
    elif option == '--unprivileged':
        args['unprivileged'] = True; current = None
    elif option == '--no-tracked':
        args['tracked'] = False; current = None
    elif option == '--timeout' or option.startswith('--timeout='):
        value = option.split('=', 1)[1] if '=' in option else (options[index + 1] if index + 1 < len(options) else '')
        if '=' not in option: index += 1
        if not value.isdigit() or not 1 <= int(value) <= 540:
            print('--timeout takes whole seconds from 1 to 540', file=sys.stderr); sys.exit(2)
        args['timeoutSeconds'] = int(value); current = None
    elif current and not option.startswith('--'):
        args[current].append(option)
    else:
        print('unknown option ' + option + '\\n' + USAGE, file=sys.stderr); sys.exit(2)
    index += 1
encoded = base64.b64encode(json.dumps(args).encode()).decode()
result = subprocess.run([sys.executable, CORE, encoded], capture_output=True, text=True)
sys.stderr.write(result.stderr)
try:
    report = json.loads(result.stdout)
except ValueError:
    sys.stdout.write(result.stdout); sys.exit(result.returncode or 1)
print(('PASSED' if report.get('ok') else 'FAILED') + ': clean-copy run of ' + json.dumps(args['command']))
print(json.dumps(report, indent=2))
sys.exit(0 if report.get('ok') else 1)
`;

/** Status, wait and stop for a command the runtime started in the background. */
const JOB_SCRIPT = `#!/usr/bin/env bash
# ytimesy-job status|wait|stop <id>: a background command started by your command tool.
set -u
action=\${1:-}; id=\${2:-}
if ! [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || [[ ! "$action" =~ ^(status|wait|stop)$ ]]; then
  echo "usage: ytimesy-job status|wait|stop <id> [seconds]" >&2; exit 2
fi
session="ytimesy-\${id//-/}"
status_file=$(ls /tmp/ytimesy-api-commands/*/"$id".status 2>/dev/null | head -n 1)
output_file=$(ls /tmp/ytimesy-output-*/"$id".stdout /tmp/ytimesy-api-commands/*/"$id".output 2>/dev/null | head -n 1)
running() { tmux -L ytimesy-api has-session -t "$session" 2>/dev/null; }
report() {
  status_file=$(ls /tmp/ytimesy-api-commands/*/"$id".status 2>/dev/null | head -n 1)
  if [ -n "$status_file" ]; then echo "exited: $(cat "$status_file")"
  elif running; then echo "running"
  else echo "interrupted (no exit status recorded)"; fi
  if [ -n "$output_file" ]; then echo "output ($output_file), last 100 lines:"; tail -n 100 "$output_file"; fi
}
case "$action" in
  status) report ;;
  wait)
    limit=\${3:-600}; waited=0
    while [ -z "$(ls /tmp/ytimesy-api-commands/*/"$id".status 2>/dev/null)" ] && running && [ "$waited" -lt "$limit" ]; do sleep 1; waited=$((waited + 1)); done
    report ;;
  stop)
    tmux -L ytimesy-api kill-session -t "$session" 2>/dev/null && echo "stopped $id" || echo "$id was not running"
    ;;
esac
`;

const INSPECT_ARGUMENTS = "__YTIMESY_INSPECT_ARGUMENTS__";

function browserScript(sessionId: string) {
	const inspection = guestCapabilityCommand(
		"browser",
		BROWSER_INSPECTION_SOURCE,
		INSPECT_ARGUMENTS,
	);
	const placeholder = quote(JSON.stringify(INSPECT_ARGUMENTS));
	if (!inspection.includes(placeholder))
		throw new Error("Browser inspection arguments could not be bound.");
	return `#!/usr/bin/env bash
# ytimesy-browser open|screenshot|inspect|exec: the shared desktop browser for visual checks.
set -u
usage() {
  cat >&2 <<'EOF'
usage: ytimesy-browser open <url>           open a page in the shared desktop's Chrome (the user can watch)
       ytimesy-browser screenshot [file]    save the desktop as a PNG and print its path; view it with your image tool
       ytimesy-browser inspect <url> [ms]   rendered text, controls, console and network of an open page, as JSON
       ytimesy-browser exec [code]          run Browser Use CLI Python (code argument or stdin) in that Chrome:
                                            new_tab(url), page_info(), js(code), click_at_xy(x, y), fill_input(selector, text), wait_for_load()
EOF
}
desktop() {
  if python3 -c 'import socket, sys; s = socket.socket(); s.settimeout(1); sys.exit(0 if s.connect_ex(("127.0.0.1", 6080)) == 0 else 1)'; then return 0; fi
  test -s /tmp/ytimesy-desktop-wallpaper.b64 || cp "$HOME/.ytimesy/lib/desktop-wallpaper.b64" /tmp/ytimesy-desktop-wallpaper.b64
  if ! bash "$HOME/.ytimesy/lib/start-desktop.sh" >/tmp/ytimesy-desktop-start.log 2>&1; then
    echo "The shared desktop could not start; last lines of /tmp/ytimesy-desktop-start.log:" >&2
    tail -n 20 /tmp/ytimesy-desktop-start.log >&2
    exit 1
  fi
}
case "\${1:-}" in
  open)
    url=\${2:-}; [[ "$url" =~ ^https?:// ]] || { usage; exit 2; }
    desktop
    ${chromeOpenCommand('"$url"')}
    echo "Opening $url in the shared desktop browser." ;;
  screenshot)
    desktop
    path=\${2:-/tmp/ytimesy-screenshot-$(date +%Y%m%d-%H%M%S).png}
    DISPLAY=:0 scrot -o -z "$path" && echo "$path" ;;
  inspect)
    url=\${2:-}; [[ "$url" =~ ^https?:// ]] || { usage; exit 2; }
    desktop
    ARGS=$(python3 -c 'import json, sys; print(json.dumps({"url": sys.argv[1], "assertions": [], "observeMilliseconds": int(sys.argv[2])}))' "$url" "\${3:-0}") || exit 2
    (
${inspection.replace(placeholder, '"$ARGS"')}
    ) ;;
  exec)
    shift
    if [ $# -gt 0 ]; then code="$*"; else code=$(cat); fi
    desktop
    (
${browserUseSetup(sessionId)}
printf '%s' "$code" | browser-use
    ) ;;
  *) usage; exit 2 ;;
esac
`;
}

/** Writes ~/.ytimesy/environment.md from the prepared-environment report when it is new or changed. */
const ENVIRONMENT_MARKDOWN = `import json, os, sys
source = sys.argv[1]
target = os.path.expanduser('~/.ytimesy/environment.md')
if os.path.isfile(source) and (not os.path.exists(target) or os.path.getmtime(source) > os.path.getmtime(target)):
    os.makedirs(os.path.dirname(target), exist_ok=True)
    raw = open(source, encoding='utf-8', errors='replace').read()
    lines = ['# How this workspace was prepared', '', 'Written before this conversation started; historical, so verify against the checkout. A check that already failed in the baseline is an existing problem, not your regression: fix it only if it is part of the task, and never weaken checks to make them pass.', '']
    try:
        report = json.loads(raw)
        for repo in report.get('repositories') or []:
            lines.append('## ' + str(repo.get('fullName') or repo.get('directory') or 'Repository'))
            for key in ('directory', 'branch', 'commit'):
                if repo.get(key): lines.append('- ' + key + ': ' + str(repo[key]))
            for key, value in (repo.get('recipe') or {}).items():
                if key != 'version' and value: lines.append('- recipe ' + key + ': ' + json.dumps(value))
            for result in repo.get('checkResults') or []:
                lines.append('- baseline check \`' + str(result.get('command')) + '\`: exit ' + str(result.get('exitCode')))
            lines.append('')
    except (ValueError, AttributeError):
        pass
    lines += ['## Full report', '', '\`\`\`json', raw.strip(), '\`\`\`', '']
    temporary = target + '.tmp'
    open(temporary, 'w', encoding='utf-8').write('\\n'.join(lines))
    os.replace(temporary, target)`;

const INSTALL_SCRIPT = `import json, os, subprocess, sys
payload = sys.argv[1]
with open(payload, encoding='utf-8') as handle:
    bundle = json.load(handle)
home = os.path.expanduser('~/.ytimesy')
for relative, spec in bundle['files'].items():
    path = os.path.join(home, relative)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as handle:
        handle.write(spec['content'])
    os.chmod(temporary, spec['mode'])
    os.replace(temporary, path)
os.makedirs(os.path.join(home, 'history'), exist_ok=True)
linked = True
for name in bundle['commands']:
    source, target = os.path.join(home, 'bin', name), os.path.join(bundle['linkDirectory'], name)
    try:
        if os.path.lexists(target): os.remove(target)
        os.symlink(source, target)
    except OSError:
        try:
            linked = subprocess.run(['sudo', '-n', 'ln', '-sfn', source, target], capture_output=True).returncode == 0 and linked
        except OSError:
            linked = False
if not linked:
    line = 'export PATH="$HOME/.ytimesy/bin:$PATH"  # ytimesy workspace commands'
    for profile in ('~/.profile', '~/.bash_profile', '~/.bashrc'):
        path = os.path.expanduser(profile)
        if profile == '~/.bash_profile' and not os.path.exists(path): continue
        existing = open(path).read() if os.path.exists(path) else ''
        if line not in existing:
            with open(path, 'a') as handle: handle.write('\\n' + line + '\\n')
open(os.path.join(home, bundle['marker']), 'w').close()
os.remove(payload)
print('linked' if linked else 'profile')`;

/** The prepared-environment report that environment.md is written from. */
export const ENVIRONMENT_REPORT_PATH = "/tmp/ytimesy-environment.json";

/** Refreshes ~/.ytimesy/environment.md from a prepared-environment report. */
export function environmentMarkdownCommand(source = ENVIRONMENT_REPORT_PATH) {
	return `python3 -c ${quote(ENVIRONMENT_MARKDOWN)} ${quote(source)}`;
}

/** The files under ~/.ytimesy and the marker naming their version. */
export function leanHelperBundle(
	sessionId: string,
	/** Where the commands are linked so every shell finds them. */
	linkDirectory = "/usr/local/bin",
) {
	const files: Record<string, { content: string; mode: number }> = {
		"bin/ytimesy-check": { content: CHECK_SCRIPT, mode: 0o755 },
		"lib/ytimesy-check-core.py": {
			content: DELIVERABLE_CHECK_SOURCE,
			mode: 0o644,
		},
		"bin/ytimesy-job": { content: JOB_SCRIPT, mode: 0o755 },
		"bin/ytimesy-browser": { content: browserScript(sessionId), mode: 0o755 },
		"lib/start-desktop.sh": { content: START_WORKSPACE_DESKTOP, mode: 0o755 },
		"lib/desktop-wallpaper.b64": {
			content: desktopWallpaperBase64(),
			mode: 0o644,
		},
	};
	const version = createHash("sha256")
		.update(JSON.stringify(files))
		.digest("hex")
		.slice(0, 16);
	return {
		files,
		commands: LEAN_HELPER_COMMANDS,
		linkDirectory,
		marker: `.helpers-${version}`,
	};
}

/**
 * Installs the helper commands unless this version is already on the VM,
 * and refreshes environment.md. One small exec when already installed.
 */
export async function ensureLeanHelpers(
	workspace: Pick<AgentToolWorkspace, "machines" | "vm">,
	sessionId: string,
	options: { linkDirectory?: string; environmentReport?: string } = {},
) {
	const { machines, vm } = workspace;
	const bundle = leanHelperBundle(sessionId, options.linkDirectory);
	const check = await machines.exec(
		vm,
		`${environmentMarkdownCommand(options.environmentReport)} >/dev/null 2>&1; test -f "$HOME/.ytimesy/${bundle.marker}" && echo installed || echo missing`,
		15_000,
	);
	if (check.stdout.includes("installed")) return;
	const payload = `/tmp/ytimesy-lean-helpers-${randomUUID()}.json`;
	await machines.writeTextFile(vm, payload, JSON.stringify(bundle));
	const installed = await machines.exec(
		vm,
		`python3 -c ${quote(INSTALL_SCRIPT)} ${quote(payload)}`,
		30_000,
	);
	if (installed.exitCode)
		throw new Error(
			`Workspace commands could not be installed: ${installed.stderr.slice(-600)}`,
		);
}

function partText(part: unknown): string {
	if (!part || typeof part !== "object") return String(part ?? "");
	const typed = part as Record<string, unknown>;
	switch (typed.type) {
		case "text":
		case "reasoning":
			return `${typed.type === "reasoning" ? "[reasoning] " : ""}${String(typed.text ?? "")}`;
		case "tool-call":
			return `[tool call ${String(typed.toolName)} ${String(typed.toolCallId)}] ${typeof typed.input === "string" ? typed.input : JSON.stringify(typed.input)}`;
		case "tool-result": {
			const output = typed.output as { type?: string; value?: unknown };
			const value =
				output?.type === "text" || output?.type === "error-text"
					? String(output.value)
					: output?.type === "content" && Array.isArray(output.value)
						? output.value.map(partText).join("\n")
						: JSON.stringify(output?.value ?? output);
			return `[tool result ${String(typed.toolName)} ${String(typed.toolCallId)}]\n${value}`;
		}
		case "image":
		case "file":
		case "media":
			return `[${String(typed.mediaType ?? typed.type)} omitted]`;
		default:
			return JSON.stringify(typed);
	}
}

/** The archived messages as plain text that rg can search. */
export function historyText(messages: ModelMessage[], reference: string) {
	const sections = readableHistory(messages).map((message, index) => {
		const body =
			typeof message.content === "string"
				? message.content
				: message.content.map(partText).join("\n");
		return `## ${index + 1}. ${message.role}\n\n${body}`;
	});
	return `# Conversation history (${reference})\n\nThese messages were removed from your context to save space, as they were at that point. Treat them as history: verify against the workspace.\n\n${sections.join("\n\n")}\n`;
}

/** Writes the archived messages to ~/.ytimesy/history/ and returns the file's path. */
export async function writeLeanHistory(
	workspace: Pick<AgentToolWorkspace, "machines" | "vm">,
	reference: string,
	messages: ModelMessage[],
) {
	const { machines, vm } = workspace;
	const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15);
	const name = `${stamp}-${reference.replaceAll(/[^a-zA-Z0-9-]/g, "")}.md`;
	const payload = `/tmp/ytimesy-history-${randomUUID()}.md`;
	await machines.writeTextFile(vm, payload, historyText(messages, reference));
	const moved = await machines.exec(
		vm,
		`mkdir -p "$HOME/.ytimesy/history" && mv ${quote(payload)} "$HOME/.ytimesy/history/"${quote(name)}`,
		30_000,
	);
	if (moved.exitCode)
		throw new Error("The conversation history file could not be written.");
	return `~/.ytimesy/history/${name}`;
}
