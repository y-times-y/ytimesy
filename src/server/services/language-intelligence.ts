import { z } from "zod";

export const languageQuery = z.object({
	path: z.string().min(1).max(1000),
	operation: z.enum([
		"definition",
		"references",
		"hover",
		"rename_preview",
		"diagnostics",
	]),
	line: z.number().int().min(1),
	column: z.number().int().min(1),
	newName: z.string().min(1).max(200).optional(),
});

export const languageQueryResult = z.object({
	language: z.string(),
	operation: languageQuery.shape.operation,
	result: z.unknown(),
	diagnosticsObserved: z.boolean(),
	truncated: z.boolean(),
});

/** JSON-RPC framing/cancellation is provided by vscode-jsonrpc, never a bespoke LSP parser. */
export const LANGUAGE_INTELLIGENCE_SOURCE = String.raw`
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(process.argv[1] + '/package.json');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');
const input = JSON.parse(process.argv[2]);
const root = await realpath(input.cwd);
const file = await realpath(resolve(root, input.path));
if (!file.startsWith(root + sep)) throw new Error('The requested file is outside the task repository.');
if ((await stat(file)).size > 1000000) throw new Error('File exceeds the language inspection limit.');
const text = await readFile(file, 'utf8');
if (Buffer.byteLength(text) > 1000000) throw new Error('File exceeds the language inspection limit.');
const language = /\.[cm]?tsx?$/.test(file) ? 'typescript' : /\.[cm]?jsx?$/.test(file) ? 'javascript' : /\.py$/.test(file) ? 'python' : /\.rs$/.test(file) ? 'rust' : /\.go$/.test(file) ? 'go' : null;
if (!language) throw new Error('No configured language server for this file type.');
const tsServer = process.argv[1] + '/node_modules/.bin/typescript-language-server';
const commands = { typescript: [tsServer, '--stdio'], javascript: [tsServer, '--stdio'], python: ['pyright-langserver', '--stdio'], rust: ['rust-analyzer'], go: ['gopls', 'serve'] };
const [command, ...args] = commands[language];
const child = spawn(command, args, { cwd: root, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
const stopServer = signal => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
child.stderr.on('data', () => {});
const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
child.on('error', error => { console.error('Language server unavailable: ' + error.code); connection.dispose(); process.exitCode = 1; });
let diagnostics = [];
let diagnosticsObserved = false;
let resolveDiagnostics;
const diagnosticsReady = new Promise(resolve => { resolveDiagnostics = resolve; });
const uri = pathToFileURL(file).href;
connection.onNotification('textDocument/publishDiagnostics', value => {
  if (value.uri === uri && (value.version === undefined || value.version === 1)) {
    diagnosticsObserved = true;
    diagnostics = value.diagnostics.slice(0, 100);
    resolveDiagnostics();
  }
});
connection.onRequest('workspace/configuration', value => value.items.map(() => null));
connection.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'This capability only previews edits.' }));
connection.listen();
const watchdog = setTimeout(() => { connection.dispose(); stopServer('SIGKILL'); process.exitCode = 1; }, 40000);
try {
  await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'task' }], capabilities: { workspace: { configuration: true }, textDocument: { publishDiagnostics: { versionSupport: true } } } });
  await connection.sendNotification('initialized', {});
  await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: language, version: 1, text } });
  const position = { line: input.line - 1, character: input.column - 1 };
  const lines = text.split('\n');
  if (position.line >= lines.length || position.character > lines[position.line].length) throw new Error('Position is outside the file. Columns use UTF-16 units.');
  const methods = { definition: 'textDocument/definition', references: 'textDocument/references', hover: 'textDocument/hover', rename_preview: 'textDocument/rename' };
  let result;
  if (input.operation === 'diagnostics') {
    let timeout;
    try {
      // Project loading can outlast 2.5 seconds on a cold language server.
      // Wait for its actual notification, not an assumed clean-file deadline.
      // The watchdog still bounds hung servers and missing evidence stays explicit.
      await Promise.race([diagnosticsReady, new Promise(resolve => { timeout = setTimeout(resolve, 15000); })]);
    } finally { clearTimeout(timeout); }
    result = diagnostics;
  } else {
    if (input.operation === 'rename_preview' && !input.newName) throw new Error('newName is required for a rename preview.');
    result = await connection.sendRequest(methods[input.operation], { textDocument: { uri }, position, ...(input.operation === 'references' ? { context: { includeDeclaration: true } } : {}), ...(input.operation === 'rename_preview' ? { newName: input.newName } : {}) });
  }
  let truncated = false;
  if (Array.isArray(result) && result.length > 100) { result = result.slice(0, 100); truncated = true; }
  if (JSON.stringify(result).length > 100000) throw new Error('Language result exceeds the limit; narrow the query. No edits were applied.');
  console.log(JSON.stringify({ language, operation: input.operation, result, diagnosticsObserved, truncated }));
} finally {
  clearTimeout(watchdog);
  connection.dispose();
  stopServer('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 100));
  stopServer('SIGKILL');
}
`;
