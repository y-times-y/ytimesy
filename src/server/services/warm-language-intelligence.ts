/** Both client and language-server transport use the maintained JSON-RPC implementation. */
export const WARM_LANGUAGE_INTELLIGENCE_SOURCE = String.raw`
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, lstat, unlink } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createConnection, createServer } from 'node:net';
const require = createRequire(process.argv[1] + '/package.json');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');
const input = JSON.parse(process.argv[2]);
const root = await realpath(input.cwd);
const language = /\.[cm]?tsx?$/.test(input.path) ? 'typescript' : /\.[cm]?jsx?$/.test(input.path) ? 'javascript' : /\.py$/.test(input.path) ? 'python' : /\.rs$/.test(input.path) ? 'rust' : /\.go$/.test(input.path) ? 'go' : null;
if (!language) throw new Error('No configured language server for this file type.');
const identity = createHash('sha256').update(JSON.stringify([root, language, process.argv[1]])).digest('hex').slice(0, 20);
const directory = join(tmpdir(), 'yt-lsp-' + process.getuid() + '-' + identity);
await mkdir(directory, { mode: 0o700 }).catch(error => { if(error.code !== 'EEXIST') throw error; });
const directoryInfo = await lstat(directory);
if (!directoryInfo.isDirectory() || directoryInfo.uid !== process.getuid() || (directoryInfo.mode & 0o777) !== 0o700) throw new Error('Unsafe language-server socket directory.');
const socketPath = join(directory, 'rpc');
const rpc = stream => createMessageConnection(new StreamMessageReader(stream), new StreamMessageWriter(stream));

if (!input.daemon) {
  const connect = async () => {
    const previous = await lstat(socketPath).catch(() => null);
    return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once('error', error => { error.socketIdentity = previous; socket.destroy(); reject(error); });
    socket.once('connect', () => { socket.removeAllListeners('error'); resolve(socket); });
    });
  };
  let socket;
  try { socket = await connect(); }
  catch (error) {
    if (!['ENOENT','ECONNREFUSED'].includes(error.code)) throw error;
    if (input.onlyIfWarm) { console.log(JSON.stringify({ available: false })); process.exit(0); }
    if (error.code === 'ECONNREFUSED') {
      const info = await lstat(socketPath).catch(() => null);
      if (info?.isSocket() && info.uid === process.getuid() && info.ino === error.socketIdentity?.ino && info.dev === error.socketIdentity?.dev) await unlink(socketPath).catch(() => {});
    }
    const daemon = spawn(process.execPath, [...process.execArgv, process.argv[1], JSON.stringify({...input, daemon: true})], { cwd: root, detached: true, stdio: 'ignore' });
    daemon.unref();
    const deadline = Date.now() + 10000;
    while (!socket) {
      try { socket = await connect(); } catch (retry) {
        if (!['ENOENT','ECONNREFUSED'].includes(retry.code) || Date.now() > deadline) throw retry;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }
  const connection = rpc(socket);
  connection.listen();
  let timeout;
  try {
    const result = await Promise.race([
      connection.sendRequest(input.shutdown ? 'shutdown' : 'inspect', input),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Language request timed out.')), 40000); })
    ]);
    console.log(JSON.stringify(input.onlyIfWarm ? { available: true, ...result } : result));
  } finally { clearTimeout(timeout); connection.dispose(); socket.destroy(); }
} else {
  const clients = new Set();
  let child, connection, idle;
  let serial = Promise.resolve();
  let closing = false;
  const server = createServer(socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    const client = rpc(socket);
    client.onRequest('inspect', request => {
      clearTimeout(idle);
      const operation = serial.then(() => inspect(request));
      serial = operation.catch(() => {});
      return operation.finally(() => { idle = setTimeout(shutdown, 60000); });
    });
    client.onRequest('shutdown', () => { setTimeout(shutdown, 20); return { stopped: true }; });
    client.listen();
  });
  const stopServer = signal => { try { if (child?.pid) process.kill(-child.pid, signal); } catch {} };
  async function shutdown() {
    if (closing) return;
    closing = true;
    clearTimeout(idle);
    connection?.dispose();
    stopServer('SIGTERM');
    server.close();
    for (const socket of clients) socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 100));
    stopServer('SIGKILL');
    await unlink(socketPath).catch(() => {});
    process.exit(0);
  }
  // Bind before starting the expensive project server; concurrent starters lose safely.
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); }); }
  catch (error) { if (error.code === 'EADDRINUSE') process.exit(0); throw error; }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  const tsServer = process.argv[1] + '/node_modules/.bin/typescript-language-server';
  const commands = { typescript: [tsServer, '--stdio'], javascript: [tsServer, '--stdio'], python: ['pyright-langserver', '--stdio'], rust: ['rust-analyzer'], go: ['gopls', 'serve'] };
  const [command, ...args] = commands[language];
  child = spawn(command, args, { cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  child.on('error', shutdown);
  child.on('exit', shutdown);
  connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  const documents = new Map();
  connection.onNotification('textDocument/publishDiagnostics', value => {
    const document = documents.get(value.uri);
    if (document && (value.version === undefined || value.version === document.version)) {
      document.observed = true;
      document.diagnostics = value.diagnostics.slice(0, 100);
      document.truncated = value.diagnostics.length > 100;
      document.resolve();
    }
  });
  connection.onRequest('workspace/configuration', value => value.items.map(() => null));
  connection.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'This capability only previews edits.' }));
  connection.listen();
  const initialized = (async () => {
    await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, workspaceFolders: [{uri: pathToFileURL(root).href, name: 'task'}], capabilities: {workspace: {configuration: true}, textDocument: {publishDiagnostics: {versionSupport: true}}} });
    await connection.sendNotification('initialized', {});
  })();
  initialized.catch(shutdown);
  idle = setTimeout(shutdown, 60000);
  async function inspect(request) {
    let watchdog;
    try {
      return await Promise.race([perform(request), new Promise((_, reject) => { watchdog = setTimeout(() => { reject(new Error('Language server stalled.')); void shutdown(); }, 35000); })]);
    } finally { clearTimeout(watchdog); }
  }
  async function perform(request) {
    if (await realpath(request.cwd) !== root) throw new Error('Project mismatch.');
    if (request.deleted) {
      const file = resolve(root, request.path);
      if (!file.startsWith(root + sep)) throw new Error('The requested file is outside the task repository.');
      await initialized;
      const uri = pathToFileURL(file).href;
      if (documents.has(uri)) await connection.sendNotification('textDocument/didClose', {textDocument: {uri}});
      documents.delete(uri);
      return {closed: true};
    }
    const file = await realpath(resolve(root, request.path));
    if (!file.startsWith(root + sep) || file.slice(root.length + 1).split(sep).includes('.git')) throw new Error('The requested file is outside repository source files.');
    if ((await stat(file)).size > 1000000) throw new Error('File exceeds the language inspection limit.');
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text) > 1000000) throw new Error('File exceeds the language inspection limit.');
    const position = {line: request.line - 1, character: request.column - 1};
    const lines = text.split('\n');
    if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0 || position.line >= lines.length || position.character > lines[position.line].length) throw new Error('Position is outside the file. Columns use UTF-16 units.');
    const methods = {definition: 'textDocument/definition', references: 'textDocument/references', hover: 'textDocument/hover', rename_preview: 'textDocument/rename'};
    if (request.operation !== 'diagnostics' && !methods[request.operation]) throw new Error('Unsupported language operation.');
    if (request.operation === 'rename_preview' && !request.newName) throw new Error('newName is required for a rename preview.');
    await initialized;
    const uri = pathToFileURL(file).href;
    const previous = documents.get(uri);
    const document = {version: (previous?.version ?? 0) + 1, observed: false, diagnostics: [], truncated: false, resolve: null};
    document.ready = new Promise(resolve => { document.resolve = resolve; });
    documents.set(uri, document);
    if (previous) await connection.sendNotification('textDocument/didChange', {textDocument: {uri, version: document.version}, contentChanges: [{text}]});
    else await connection.sendNotification('textDocument/didOpen', {textDocument: {uri, languageId: language, version: document.version, text}});
    let result;
    if (request.operation === 'diagnostics') {
      let timeout;
      try { await Promise.race([document.ready, new Promise(resolve => { timeout = setTimeout(resolve, 15000); })]); }
      finally { clearTimeout(timeout); }
      result = document.diagnostics;
    } else result = await connection.sendRequest(methods[request.operation], {textDocument: {uri}, position, ...(request.operation === 'references' ? {context: {includeDeclaration: true}} : {}), ...(request.operation === 'rename_preview' ? {newName: request.newName} : {})});
    let truncated = document.truncated;
    if (Array.isArray(result) && result.length > 100) { result = result.slice(0, 100); truncated = true; }
    if (JSON.stringify(result).length > 100000) throw new Error('Language result exceeds the limit; narrow the query. No edits were applied.');
    return {language, operation: request.operation, result, diagnosticsObserved: document.observed, truncated, serverId: process.pid};
  }
}
`;
