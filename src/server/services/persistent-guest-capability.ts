import { z } from "zod";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	guestCapabilityCommand,
	guestCapabilityDirectory,
} from "./guest-node-capability";
import type { WorkspaceMachines } from "./workspace-machines";

/** Keyed per VM (vm-edge-keys.ts); publishing a new port replaces the old route. */
export { guestServiceHostname } from "./vm-edge-keys";

const endpoint = z.object({
	port: z.number().int().min(1024).max(65535),
	token: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Reuses an authenticated guest process. A lost response is never automatically replayed. */
export function persistentGuestCapabilityRunner(
	machines: WorkspaceMachines,
	expose: (vm: WorkspaceId, port: number) => Promise<string>,
): NonNullable<WorkspaceMachines["runCapability"]> {
	const connections = new Map<
		string,
		Promise<{ origin: string; token: string }>
	>();
	const installations = new Map<string, Promise<void>>();
	async function connect(vm: WorkspaceId) {
		const command = guestCapabilityCommand(
			"language",
			PERSISTENT_GUEST_SOURCE,
			{ bootstrap: true },
		);
		const launched = await machines.exec(
			vm,
			`flock -w 175 /tmp/ytimesy-capability-service-start.lock sh -c ${quote(command)}`,
			180000,
		);
		if (launched.exitCode)
			throw new Error("Persistent guest service could not start.");
		const { port, token } = endpoint.parse(JSON.parse(launched.stdout));
		const origin = await expose(vm, port);
		if (
			new URL(origin).protocol !== "https:" &&
			!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)
		)
			throw new Error("Guest service requires HTTPS.");
		return { origin, token };
	}
	return async (vm, request, signal) => {
		signal.throwIfAborted();
		if (request.onlyInstalled && !connections.has(vm))
			return machines.exec(
				vm,
				guestCapabilityCommand(
					request.capability,
					request.source,
					request.arguments,
					{ onlyInstalled: true },
				),
				60000,
			);
		if (!connections.has(vm)) connections.set(vm, connect(vm));
		let stage = "start";
		try {
			const remote = await connections.get(vm);
			if (!remote) throw new Error("Guest service connection is unavailable.");
			const installation = `${vm}:${request.capability}`;
			if (
				request.capability !== "language" &&
				!installations.has(installation)
			) {
				installations.set(
					installation,
					machines
						.exec(
							vm,
							guestCapabilityCommand(
								request.capability,
								"console.log('{}')",
								{},
							),
							180000,
						)
						.then((result) => {
							if (result.exitCode)
								throw new Error("Guest dependency preparation failed.");
						}),
				);
			}
			stage = "install";
			if (installations.has(installation))
				await installations.get(installation);
			stage = "request";
			const response = await fetch(`${remote.origin}/execute`, {
				method: "POST",
				redirect: "manual",
				signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
				headers: {
					authorization: `Bearer ${remote.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					source: request.source,
					packages: guestCapabilityDirectory(request.capability),
					input: request.arguments,
				}),
			});
			if (!response.ok)
				throw new Error(`Guest service returned HTTP ${response.status}.`);
			const text = await response.text();
			if (text.length > 300000)
				throw new Error("Guest service response exceeded limit.");
			return z
				.object({
					exitCode: z.number().int(),
					stdout: z.string().max(256000),
					stderr: z.string().max(2000),
				})
				.parse(JSON.parse(text));
		} catch (error) {
			connections.delete(vm);
			for (const key of installations.keys())
				if (key.startsWith(`${vm}:`)) installations.delete(key);
			throw new Error(
				`Guest service request failed at ${stage} (${guestServiceFailure(error)}); its outcome may be uncertain. Inspect state before retrying.`,
				{ cause: error },
			);
		}
	};
}

export const PERSISTENT_GUEST_SOURCE = String.raw`
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes, createHash, timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,rename,lstat} from 'node:fs/promises';
const require = createRequire(process.argv[1] + '/package.json');
const input = JSON.parse(process.argv[2]);
const version = createHash('sha256').update(process.execArgv.join(' ')).digest('hex').slice(0,16);
const record = process.argv[1] + '/service-' + version + '.json';
if (input.bootstrap) {
  const info = await lstat(record).catch(() => null);
  if (info && (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600)) throw new Error('Unsafe service record.');
  const previous = info ? JSON.parse(await readFile(record,'utf8')) : null;
  if (previous) {
    const response = await fetch('http://127.0.0.1:' + previous.port + '/health', {headers:{authorization:'Bearer ' + previous.token},signal:AbortSignal.timeout(1000)}).catch(() => null);
    if (response?.ok) { console.log(JSON.stringify(previous)); process.exit(0); }
  }
  const token = randomBytes(32).toString('hex');
  const daemon = spawn(process.execPath,[...process.execArgv,process.argv[1],JSON.stringify({token,daemon:true})],{detached:true,stdio:'ignore'});
  daemon.unref();
  for (let attempt=0;attempt<100;attempt++) {
    const ready = await readFile(record,'utf8').then(JSON.parse,()=>null);
    if (ready?.token === token) { console.log(JSON.stringify(ready)); process.exit(0); }
    await new Promise(resolve => setTimeout(resolve,50));
  }
  try {process.kill(-daemon.pid,'SIGTERM');} catch {}
  throw new Error('Guest service startup timed out.');
}
const ts = require('typescript');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const programs = new Map();
let idle;
const armIdle = () => {clearTimeout(idle); idle=setTimeout(()=>process.exit(0),300000);};
const server = createServer(async (request,response) => {
  const presented = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + input.token);
  if (presented.length !== expected.length || !timingSafeEqual(presented,expected)) {response.writeHead(401); response.end(); return;}
  if (request.method === 'GET' && request.url === '/health') {response.end('{}');return;}
  if (request.method !== 'POST' || request.url !== '/execute' || request.headers.origin) {response.writeHead(403);response.end();return;}
  clearTimeout(idle);
  let stdout='',stderr='',timer;
  try {
    const chunks=[];let size=0;
    for await (const chunk of request) {size+=chunk.length;if(size>500000)throw new Error('Request too large.');chunks.push(chunk);}
    const job=JSON.parse(Buffer.concat(chunks).toString());
    if (typeof job.source !== 'string' || job.source.length>100000 || !/^\/tmp\/ytimesy-capability-[a-z]+-[a-f0-9]{16}$/.test(job.packages)) throw new Error('Invalid guest program.');
    const digest=createHash('sha256').update(job.source).digest('hex');
    let program=programs.get(digest);
    if (!program) {
      const compiled=ts.transpileModule(job.source,{
        compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
        transformers:{after:[context=>file=>ts.visitNode(file,function visit(node){
          if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='require'&&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text.startsWith('node:'))return context.factory.updateCallExpression(node,context.factory.createIdentifier('__yt_import'),node.typeArguments,node.arguments);
          return ts.visitEachChild(node,visit,context);
        })]}
      }).outputText;
      program=new AsyncFunction('__yt_import','process','console','exports',compiled);
      if(programs.size>=32)programs.delete(programs.keys().next().value);
      programs.set(digest,program);
    }
    const capture=text=>{stdout+=String(text);if(stdout.length>256000)throw new Error('Guest output exceeds limit.');};
    const exit={};
    const scopedProcess=Object.create(process);
    Object.defineProperties(scopedProcess,{
      argv:{value:[process.execPath,job.packages,JSON.stringify(job.input)]},
      execArgv:{value:['--input-type=module','-e',job.source]},
      stdout:{value:{write:capture}},stderr:{value:{write:text=>{stderr=(stderr+String(text)).slice(-2000);}}},
      exit:{value:code=>{if(code)throw new Error('Guest program exited with '+code);throw exit;}}
    });
    const execution=program(require,scopedProcess,{log:(...args)=>capture(args.join(' ')+'\n'),error:(...args)=>{stderr=(stderr+args.join(' ')).slice(-2000);}},{}).catch(error=>{if(error!==exit)throw error;});
    await Promise.race([execution,new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new Error('Guest program timed out; outcome uncertain.'));setTimeout(()=>process.exit(1),100);},55000);})]);
    response.setHeader('content-type','application/json');response.end(JSON.stringify({exitCode:0,stdout,stderr}));
  } catch(error) {response.end(JSON.stringify({exitCode:1,stdout:'',stderr:String(error?.message??error).slice(-2000)}));}
  finally {clearTimeout(timer);armIdle();}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'0.0.0.0',resolve);});
await writeFile(record+'.tmp',JSON.stringify({port:server.address().port,token:input.token}),{mode:0o600});
await rename(record+'.tmp',record);
armIdle();
`;

/** Class and a short message: enough to tell a TLS, DNS, timeout or HTTP failure apart. */
function guestServiceFailure(error: unknown) {
	if (!(error instanceof Error)) return "unknown";
	const message = error.message.replaceAll(
		/Bearer\s+\S+/g,
		"Bearer [redacted]",
	);
	return `${error.name}: ${message}`.slice(0, 200);
}
