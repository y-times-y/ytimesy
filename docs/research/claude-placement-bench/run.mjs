// Usage: node run.mjs <builtin|mcp> <tool calls> <model delay ms> [one-way network delay ms to the tool endpoint]
// Needs the Claude Agent SDK installed at SDK_DIR (default /tmp/sdk-next). Scripted model, so it measures harness overhead only.
import { pathToFileURL } from 'node:url'; import { spawn } from 'node:child_process'; import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const here = new URL('./', import.meta.url).pathname;
const [mode, steps, modelDelay, oneWay] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5] ?? 0)];
const sdk = (process.env.SDK_DIR ?? '/tmp/sdk-next') + '/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const { query } = await import(pathToFileURL(sdk).href);
const mport = 19000 + Math.floor(Math.random() * 500), vport = mport + 1000;
const procs = [];
const start = (file, ...a) => { const p = spawn('node', [file, ...a], { stdio: ['ignore', 'pipe', 'inherit'] }); procs.push(p); return p; };
const mock = start(here + 'mock-model.mjs', mport, mode, steps, modelDelay);
const stamps = []; let buf = ''; mock.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { try { stamps.push(JSON.parse(buf.slice(0, i))); } catch {} buf = buf.slice(i + 1); } });
if (mode === 'mcp') start(here + 'vm-tools.mjs', vport, oneWay);
await new Promise(r => setTimeout(r, 500));
const home = mkdtempSync(join(tmpdir(), 'placebench-'));
const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 'grant-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${mport}`,
  DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
const options = { model: 'claude-sonnet-5-5', permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, env, cwd: home,
  systemPrompt: { type: 'preset', preset: 'claude_code', append: 'bench' } };
if (mode === 'mcp') { options.tools = []; options.mcpServers = { vm: { type: 'http', url: `http://127.0.0.1:${vport}/mcp` } }; }
const t0 = Date.now(); let result = '';
for await (const m of query({ prompt: 'run it', options })) if (m.type === 'result') result = m.subtype + ':' + (m.result ?? '').slice(0, 20);
const total = Date.now() - t0;
const first = stamps[0]?.t - t0, last = stamps.at(-1)?.t - t0;
console.log(JSON.stringify({ mode, steps, modelDelay, oneWay, total, firstRequestMs: first, lastRequestMs: last, requests: stamps.length, result,
  perToolCallMs: Math.round(((last - first) / Math.max(1, stamps.length - 1)) - modelDelay) }));
procs.forEach(p => p.kill()); process.exit(0);
