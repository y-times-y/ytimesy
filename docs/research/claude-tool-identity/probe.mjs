import http from 'node:http';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const { query } = await import(process.env.CLAUDE_AGENT_SDK_MODULE ?? '/opt/ytimesy-claude-agent-sdk/0.3.321/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
const home = await mkdtemp(join(tmpdir(), 'ytimesy-tool-id-'));
const hooks = [], calls = [], nativeIds = [];
let result = null;
const resumeProbe = process.argv.includes('--resume-after-kill');
const nativeOnly = resumeProbe || process.argv.includes('--native-only');
let resuming = false, heldResponse = null, sessionId = null, child = null;
const resumedResults = [];
let markHung;
const hung = new Promise(resolve => { markHung = resolve; });
const waitForPersistedCall = async () => {
  for (let attempt=0; attempt<100; attempt++) {
    const files = (await readdir(home,{recursive:true})).filter(path=>path.endsWith('.jsonl'));
    for (const path of files) if ((await readFile(join(home,path),'utf8')).includes('toolu_identity_0')) return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('SDK did not persist the pending tool call before the kill');
};
const read = async req => { const chunks=[]; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString() || '{}'); };
const server = http.createServer(async (req,res) => {
  const j = await read(req);
  const json = value => { res.setHeader('content-type','application/json'); res.end(JSON.stringify(value)); };
  if (req.url === '/mcp') {
    if (j.id === undefined) { res.statusCode=202; return res.end(); }
    const reply = value => json({jsonrpc:'2.0', id:j.id, result:value});
    if (j.method === 'initialize') return reply({protocolVersion:j.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'identity-probe',version:'1'}});
    if (j.method === 'tools/list') return reply({tools:[{name:'bash',description:'Identity probe only; no command executes.',inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false}}]});
    if (j.method === 'tools/call') {
      calls.push(j.params.arguments);
      const id = j.params._meta?.['claudecode/toolUseId'] ?? null;
      nativeIds.push(id);
      if (resumeProbe && !resuming && id === 'toolu_identity_0') { heldResponse=res; markHung(); return; }
      return reply({content:[{type:'text',text:'probe recorded; no command executed'}]});
    }
    return reply({});
  }
  if (req.url.startsWith('/v1/messages/count_tokens')) return json({input_tokens:10});
  if (!req.url.startsWith('/v1/messages') || !j.messages || !j.stream || j.max_tokens === 1) return json({id:'side',type:'message',role:'assistant',model:j.model,content:[{type:'text',text:'ok'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}});
  if (resuming) for (const message of j.messages) for (const block of (Array.isArray(message.content) ? message.content : [])) {
    if (block.type === 'tool_result') resumedResults.push({id:block.tool_use_id,isError:block.is_error===true,mentionsInterrupted:/interrupted|unknown/i.test(JSON.stringify(block.content))});
  }
  const done = resuming || JSON.stringify(j.messages).includes('tool_result');
  res.setHeader('content-type','text/event-stream');
  const ev = (type,data) => res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  ev('message_start',{message:{id:done?'done':'start',type:'message',role:'assistant',model:j.model,content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:1}}});
  if (done) {
    ev('content_block_start',{index:0,content_block:{type:'text',text:''}});
    ev('content_block_delta',{index:0,delta:{type:'text_delta',text:'DONE'}});
    ev('content_block_stop',{index:0});
  } else for (let index=0; index<2; index++) {
    ev('content_block_start',{index,content_block:{type:'tool_use',id:`toolu_identity_${index}`,name:'mcp__vm__bash',input:{}}});
    ev('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify({command:'same harmless input'})}});
    ev('content_block_stop',{index});
  }
  ev('message_delta',{delta:{stop_reason:done?'end_turn':'tool_use'},usage:{output_tokens:2}});
  ev('message_stop',{}); res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const options={model:'claude-sonnet-5-5',cwd:home,tools:[],permissionMode:'bypassPermissions',allowDangerouslySkipPermissions:true,maxTurns:3,
    env:{PATH:process.env.PATH,HOME:home,CLAUDE_CODE_OAUTH_TOKEN:'probe-not-a-real-token',ANTHROPIC_BASE_URL:origin,DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'},
    mcpServers:{vm:{type:'http',url:origin+'/mcp'}},hooks:nativeOnly ? {} : {PreToolUse:[{hooks:[async input=>{ hooks.push(input.tool_use_id); return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{...input.tool_input,__ytimesy_call_id:input.tool_use_id}}}; }]}]}};
  let killedError = null;
  if (resumeProbe) {
    options.spawnClaudeCodeProcess = settings => { child=spawn(settings.command,settings.args,{cwd:settings.cwd,env:settings.env,stdio:['pipe','pipe','pipe']}); return child; };
    const original = (async () => {
      try { for await (const m of query({prompt:'Record the two probe calls.',options})) if (m.type==='system' && m.subtype==='init') sessionId=m.session_id; }
      catch (error) { killedError=error.name; }
    })();
    let timer;
    try { await Promise.race([hung,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('No in-flight MCP request')),20000);})]); }
    finally { clearTimeout(timer); }
    await waitForPersistedCall();
    assert.ok(sessionId); assert.ok(child?.pid);
    assert.equal(child.kill('SIGKILL'),true);
    heldResponse?.destroy();
    await original;
    resuming=true;
    for await (const m of query({prompt:'Continue the probe; report completion.',options:{...options,resume:sessionId}})) if(m.type==='result') result=m.subtype;
    console.log(JSON.stringify({sdk:'0.3.321',resumeAfterKill:true,result,killedError,originalCallPersisted:true,nativeIds,resumedResults,paidModelRequests:0,commandsExecuted:0}));
    assert.equal(result,'success');
    assert.equal(nativeIds.filter(id=>id==='toolu_identity_0').length,1,'SDK reissued the interrupted invocation');
    assert.ok(resumedResults.some(entry=>entry.id==='toolu_identity_0' && entry.isError),'Resumed model did not receive an interrupted result');
  } else {
  for await (const m of query({prompt:'Record the two probe calls.',options})) if(m.type==='result') result=m.subtype;
  console.log(JSON.stringify({sdk:'0.3.321',nativeOnly,result,hookIds:hooks,receivedIds:calls.map(c=>c.__ytimesy_call_id ?? null),nativeIds,calls:calls.length,strictSchema:true,paidModelRequests:0,commandsExecuted:0}));
  assert.equal(result,'success');
  assert.equal(calls.length,2);
  if (nativeOnly) { assert.deepEqual(hooks,[]); assert.ok(calls.every(c=>c.__ytimesy_call_id === undefined)); }
  else assert.deepEqual(calls.map(c=>c.__ytimesy_call_id).sort(),['toolu_identity_0','toolu_identity_1']);
  assert.deepEqual([...nativeIds].sort(),['toolu_identity_0','toolu_identity_1']);
  }
} finally { child?.kill('SIGKILL'); heldResponse?.destroy(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await rm(home,{recursive:true,force:true}); }