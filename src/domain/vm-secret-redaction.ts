import { posixShellQuoted as quote } from "./posix-command";
import { AGENT_SECRETS_ENV_PATH, REDACTED } from "./project-secret";

/**
 * Runtime secrets redacted on the chat's VM itself, for the workspace tools a
 * Claude runner box serves (docs/claude-code-placement.md, "Workspace tools
 * on the box"). The values are already on the VM, in the env file every
 * command sources (AGENT_SECRETS_ENV_PATH, `export NAME='value'` lines and
 * YTIMESY_REDACTED_SECRETS naming the runtime ones); the box must never hold
 * them, nor a hash of them. So each command the box runs is wrapped: its
 * stdout and stderr go to private temporary files on the VM, and a filter
 * there replaces every runtime value, in the same forms as the edge's
 * `secretForms` (project-secret.ts), with the same placeholder before
 * anything is sent back. The box learns only how many were replaced.
 */

/** Ends the redacted stderr: the replacement count. Missing means the filter did not run. */
const MARKER = "ytimesy-vm-redaction:";

/**
 * The filter (argv: the directory holding `o` and `e`). A port of
 * `secretForms` and `redactSecretValues`: lengths in UTF-16 units as in
 * JavaScript, the same forms in the same order, sorted longest first
 * (stably), replaced one after another. Tool helpers on the VM print JSON
 * (some with ASCII escapes), which the edge decodes before redacting, so each
 * form is also matched JSON-escaped; for ordinary values that is the same
 * text. Bytes are replaced as UTF-8, which matches the edge on text.
 */
export const VM_REDACTION_SCRIPT = String.raw`import base64, json, os, sys, urllib.parse
def units(s): return len(s.encode('utf-16-le', 'surrogatepass')) // 2
def raw(s): return s.encode('utf-8', 'surrogateescape')
def b64(b): return base64.b64encode(b).decode()
def forms(s):
    out = [s]
    def add(f):
        if f not in out: out.append(f)
    if units(s) >= 8:
        b = raw(s)
        add(json.dumps(s, ensure_ascii=False)[1:-1])
        add(urllib.parse.quote(b, safe="!'()*-._~"))
        h = b.hex(); add(h); add(h.upper())
        p = b64(b); encoded = [p, p.rstrip('=')]
        for o in (0, 1, 2):
            a = 4 if o else 0
            m = b64(bytes(o) + b)[a:a + (len(b) - (3 - o if o else 0)) // 3 * 4]
            if len(m) >= 8: encoded.append(m)
        for f in encoded: add(f); add(f.replace('+', '-').replace('/', '_'))
    return [f for f in out if units(f) >= 6]
def escaped(f): return [f, json.dumps(f, ensure_ascii=False)[1:-1], json.dumps(f)[1:-1]]
names = os.environ.get('YTIMESY_REDACTED_SECRETS', '').split()
values = [os.environ[n] for n in names if os.environ.get(n)]
usable = [raw(e) for e in sorted([e for v in values if units(v) >= 6 for f in forms(v) for e in escaped(f)], key=units, reverse=True)]
placeholder = ${JSON.stringify(REDACTED)}.encode()
replaced = 0
for name, stream in (('o', sys.stdout.buffer), ('e', sys.stderr.buffer)):
    with open(os.path.join(sys.argv[1], name), 'rb') as handle: data = handle.read()
    for form in usable:
        found = data.count(form)
        if found: replaced += found; data = data.replace(form, placeholder)
    stream.write(data); stream.flush()
sys.stderr.buffer.write(b'\n${MARKER}%d\n' % replaced); sys.stderr.flush()`;

/** What the box shows when the filter could not run: the output stays on the VM. */
export const VM_REDACTION_FAILED =
	"ytimesy could not redact this output on the workspace, so it is not shown.";

/**
 * `command` with its output redacted on the VM before it leaves. Its exit
 * status is kept; when the filter cannot run (no env file, no python3) the
 * output is dropped and the status is 125. The env file is sourced only in
 * the filter's subshell, as SOURCE_AGENT_SECRETS does for commands.
 */
export function vmRedactedCommand(
	command: string,
	envPath: string = AGENT_SECRETS_ENV_PATH,
) {
	return `ytimesy_vm_redaction=$(mktemp -d) || exit 125
(
${command}
) >"$ytimesy_vm_redaction/o" 2>"$ytimesy_vm_redaction/e"
ytimesy_vm_status=$?
( . ${quote(envPath)} && export YTIMESY_REDACTED_SECRETS && exec python3 -c ${quote(VM_REDACTION_SCRIPT)} "$ytimesy_vm_redaction" ) || { ytimesy_vm_status=125; echo ${quote(VM_REDACTION_FAILED)} >&2; }
rm -rf "$ytimesy_vm_redaction"
exit $ytimesy_vm_status`;
}

/**
 * The redacted output's stderr without the filter's marker, and how many
 * values it replaced; null when the marker is missing (the filter did not
 * run or was cut off), so the output must not be trusted as redacted.
 */
export function unwrapVmRedaction(
	stderr: string,
): { stderr: string; replaced: number } | null {
	const found = /\nytimesy-vm-redaction:(\d+)\n$/.exec(stderr);
	if (!found) return null;
	return {
		stderr: stderr.slice(0, found.index),
		replaced: Number(found[1]),
	};
}

/**
 * Run by the edge before granting box tools to a turn with runtime secrets:
 * succeeds (exit 0, with the marker) only when the env file is readable by
 * the command user, names runtime secrets, and the filter runs. Prints no
 * value.
 */
export function vmRedactionProbe(envPath: string = AGENT_SECRETS_ENV_PATH) {
	return `( . ${quote(envPath)} && [ -n "$YTIMESY_REDACTED_SECRETS" ] ) >/dev/null 2>&1 || exit 3
${vmRedactedCommand(":", envPath)}`;
}

/** Whether a probe's result shows the VM can redact runtime secrets itself. */
export function vmRedactionReady(result: {
	readonly exitCode: number;
	readonly stderr: string;
}) {
	return result.exitCode === 0 && unwrapVmRedaction(result.stderr) !== null;
}
