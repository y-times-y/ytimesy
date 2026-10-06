import { randomUUID } from "node:crypto";
import { posixShellCommand } from "#/domain/posix-command";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

const RUN = `import json, os, pathlib, signal, subprocess, sys
root=pathlib.Path(sys.argv[1]); root.mkdir(parents=True,exist_ok=True)
if (root/'stopped').exists(): sys.exit(130)
record=root/(sys.argv[2]+'.json')
environment=os.environ.copy()
environment.pop('FORCE_COLOR',None)
environment['NO_COLOR']='1'
environment['TERM']='dumb'
process=subprocess.Popen(['bash','-lc',sys.argv[4]],cwd=sys.argv[3],env=environment,start_new_session=True)
tick=pathlib.Path('/proc/'+str(process.pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
temporary=record.with_suffix('.tmp')
temporary.write_text(json.dumps({'pid':process.pid,'start':tick})); temporary.replace(record)
def stop(*_):
    try: os.killpg(process.pid,signal.SIGTERM)
    except ProcessLookupError: pass
    try: process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try: os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        process.wait()
signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGHUP,stop)
if (root/'stopped').exists(): stop()
try:
    try: result=process.wait(timeout=int(sys.argv[5]))
    except subprocess.TimeoutExpired: stop(); result=124
finally:
    try: os.killpg(process.pid,signal.SIGKILL)
    except ProcessLookupError: pass
    record.unlink(missing_ok=True)
sys.exit(result if result>=0 else 128-result)`;

const STOP = `import json, os, pathlib, signal, sys, time
root=pathlib.Path(sys.argv[1])
root.mkdir(parents=True,exist_ok=True); (root/'stopped').touch()
targets=[]
for record in root.glob('*.json'):
    try:
        saved=json.loads(record.read_text()); pid=int(saved['pid'])
        tick=pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
        if pid>1 and os.getpgid(pid)==pid and tick==saved['start']:
            targets.append(pid); os.killpg(pid,signal.SIGTERM)
    except (FileNotFoundError,ProcessLookupError): pass
deadline=time.monotonic()+2
while targets and time.monotonic()<deadline:
    alive=[]
    for pid in targets:
        try: os.killpg(pid,0); alive.append(pid)
        except ProcessLookupError: pass
    targets=alive
    if targets: time.sleep(.05)
for pid in targets:
    try: os.killpg(pid,signal.SIGKILL)
    except ProcessLookupError: pass`;

export function commandScopeRoot(turnId: string) {
	if (!/^[a-zA-Z0-9-]{1,80}$/.test(turnId))
		throw new Error("Invalid command scope.");
	return `/tmp/ytimesy-api-command-scopes/${turnId}`;
}
export function scopedShellCommand(input: {
	turnId: string;
	cwd: string;
	command: string;
	seconds: number;
}) {
	return posixShellCommand([
		"python3",
		"-c",
		RUN,
		commandScopeRoot(input.turnId),
		randomUUID(),
		input.cwd,
		input.command,
		String(input.seconds),
	]);
}
export async function stopApiTurnCommands(
	workspace: AgentToolWorkspace,
	turnId: string,
) {
	const result = await workspace.machines.exec(
		workspace.vm,
		posixShellCommand(["python3", "-c", STOP, commandScopeRoot(turnId)]),
		10_000,
	);
	if (result.exitCode !== 0)
		throw new Error("Could not confirm cancellation of owned commands.");
}
