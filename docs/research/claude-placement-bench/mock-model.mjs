// Scripted Anthropic Messages API: N sequential tool calls, then a final text. Logs request times.
import http from 'node:http';
const [port, mode, steps, delayMs] = [Number(process.argv[2]), process.argv[3], Number(process.argv[4]), Number(process.argv[5])];
export const times = [];
const tool = mode === 'builtin' ? 'Bash' : 'mcp__vm__bash';
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  if (req.url.startsWith('/v1/messages/count_tokens')) { res.setHeader('content-type','application/json'); return res.end('{"input_tokens":10}'); }
  if (!req.url.startsWith('/v1/messages')) { res.statusCode = req.method === 'GET' ? 200 : 404; return res.end('{}'); }
  const j = JSON.parse(body);
  if (!j.messages || j.max_tokens === 1 || j.stream !== true) { // quota/title side calls
    res.setHeader('content-type','application/json'); return res.end(JSON.stringify({id:'m',type:'message',role:'assistant',model:j.model,content:[{type:'text',text:'ok'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}})); }
  const results = JSON.stringify(j.messages).split('"tool_result"').length - 1;
  console.log(JSON.stringify({ t: Date.now(), results }));
  await new Promise(r => setTimeout(r, delayMs));
  res.setHeader('content-type', 'text/event-stream');
  const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
  const done = results >= steps;
  ev('message_start', { type: 'message_start', message: { id: 'm' + results, type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  if (done) {
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DONE' } });
    ev('content_block_stop', { type: 'content_block_stop', index: 0 });
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
  } else {
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_' + results, name: tool, input: {} } });
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'echo hi', description: 'x' }) } });
    ev('content_block_stop', { type: 'content_block_stop', index: 0 });
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } });
  }
  ev('message_stop', { type: 'message_stop' }); res.end();
}).listen(port, '127.0.0.1');
