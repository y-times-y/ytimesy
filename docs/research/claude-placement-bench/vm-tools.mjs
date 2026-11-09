// Stand-in for the chat VM's tool endpoint: MCP over HTTP (JSON replies), one `bash` tool, simulated one-way network delay.
import http from 'node:http'; import { execFile } from 'node:child_process';
const [port, oneWayMs] = [Number(process.argv[2]), Number(process.argv[3])];
const sleep = ms => new Promise(r => setTimeout(r, ms));
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  const m = JSON.parse(Buffer.concat(chunks).toString());
  await sleep(oneWayMs);
  const reply = r => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: r })); };
  if (m.id === undefined) { res.statusCode = 202; return res.end(); }
  let out;
  if (m.method === 'initialize') out = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'vm', version: '1' } };
  else if (m.method === 'tools/list') out = { tools: [{ name: 'bash', description: 'Run a command', inputSchema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] } }] };
  else if (m.method === 'tools/call') { console.error('CALL'); out = await new Promise(r => execFile('bash', ['-c', m.params.arguments.command], (e, so) => r({ content: [{ type: 'text', text: so }] }))); }
  else out = {};
  await sleep(oneWayMs); reply(out);
}).listen(port, '127.0.0.1');
