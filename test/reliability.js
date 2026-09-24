"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { Agent } = require("../electron/agent");
const { compact, estimateTokens } = require("../electron/compactor");
const { executeTask, mapLimit } = require("../electron/execution");
const { executeToolResult } = require("../electron/tools");
const { ToolOutputStore } = require("../electron/tool-output");
const tuning = require("../electron/tuning");
const providers = require("../electron/providers");
const { gatewayModel, filterModels, probe } = require("../electron/model-catalog");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-reliable-"));
const originalFetch = global.fetch;
const reply = content => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { headers: { "content-type": "application/json" } });
const make = opts => new Agent({ baseUrl: "http://fixture.invalid/v1", apiKey: "fixture", workspace, model: "primary", streaming: false, emit() {}, canSpawn: false, ...opts });
let child, server;
let assertions = 0;
const check = (name, fn) => { fn(); assertions++; console.log("✓", name); };

(async () => {
  let requests = [];
  global.fetch = async (_url, opts) => {
    const b = JSON.parse(opts.body); requests.push(b);
    return b.model === "primary" ? new Response("quota", { status: 429, headers: { "retry-after": "2" } }) : reply("finished");
  };
  const a = make({ fallbackModels: ["backup"], streaming: true });
  await a.send("one"); await a.send("two");
  check("429 rotates without a second streaming attempt or a permanent switch", () => {
    assert.equal(requests.filter(r => r.model === "primary").length, 1); assert.equal(a.model, "primary");
    assert.equal(a.effectiveModel, "backup"); assert(a.cooling.get("primary") - Date.now() <= 2000);
  });
  a.cooling.set("primary", Date.now() - 1);
  global.fetch = async (_u, opts) => { requests.push(JSON.parse(opts.body)); return reply("recovered"); };
  await a.send("three");
  check("primary returns after cooldown", () => assert.equal(requests.at(-1).model, "primary"));
  a.setModel("auto"); a.setModel("local/private");
  check("user model switch refreshes utility and tier policy", () => { assert.equal(a.utilityModel, "local/private"); assert.equal(a.tiers, null); });

  const history = [{ role: "system", content: "system" }, { role: "user", content: "Implement this task; preserve the public API." }];
  for (let i = 0; i < 30; i++) history.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, function: { name: "read_file", arguments: "{}" } }] }, { role: "tool", tool_call_id: `c${i}`, content: "x".repeat(48000) });
  const out = await compact(history, async () => "Earlier files were inspected; continue the task.");
  check("single-user-turn compaction shrinks history and preserves constraints and tool pairing", () => {
    assert(estimateTokens(out.messages) < estimateTokens(history) / 4); assert(out.messages[1].content.includes("preserve the public API"));
    const calls = new Set(); for (const m of out.messages) { for (const c of m.tool_calls || []) calls.add(c.id); if (m.role === "tool") assert(calls.has(m.tool_call_id)); }
  });
  const again = await compact([...out.messages, ...history.slice(2)], async () => "Continue implementing.");
  check("repeated compaction retains the original task independently of the summary model",()=>assert(again.messages[1].content.includes("preserve the public API")));
  const smallHistory = history.map(m => m.role === "tool" ? { ...m, content: "x".repeat(2000) } : m);
  let summaryPrompt;
  const small = await compact(smallHistory, async p => { summaryPrompt = p; return "summary ".repeat(2000); }, { budget: 4000 });
  check("small-context compaction bounds both the summary request and retained summary",()=>{assert(summaryPrompt.length < 6500);assert(estimateTokens(small.messages) < 4000);});
  const raw = Array.from({ length: 200 }, (_,i) => `handle${i}: ` + "source and comments ".repeat(10)).join("\n");
  const store = new ToolOutputStore(); const paged = store.capture(raw);
  const id = /id=([a-f0-9-]+)/.exec(paged)[1];
  const at = raw.indexOf("handle150:");
  check("paged output retains the original middle and comments", () => assert(store.read(id, at, 1000).startsWith(raw.slice(at, at + 1000))));
  delete process.env.OMNIWORK_COMPRESSION;
  check("safe default overrides previously enabled gateway compression per request", () => assert.equal(tuning.requestHeaders()["x-omniroute-compression"], "off"));

  fs.writeFileSync(path.join(workspace,"source.txt"), Array.from({length:500},(_,i)=>`line ${i+1}`).join("\n"));
  const page = await executeToolResult("read_file", {path:"source.txt",start_line:350,end_line:355}, {workspace});
  const badEdit = await executeToolResult("edit_file", {path:"source.txt",old_string:"missing",new_string:"x"}, {workspace});
  check("targeted reads and exact-edit failures have reliable outcomes", () => { assert(page.text.startsWith("line 350\n")); assert(!page.text.includes("line 356\n")); assert.equal(badEdit.ok,false); assert(tuning.toolFailed(badEdit.text)); });

  global.fetch = async (_url, opts) => {
    const b = JSON.parse(opts.body);
    if (b.messages.some(m => m.role === "tool")) return reply("done");
    return new Response(JSON.stringify({ choices: [{ message: { role:"assistant",content:"",tool_calls:[{id:"write",type:"function",function:{name:"write_file",arguments:JSON.stringify({path:"blocked.txt",content:"no"})}}] }}]}), {headers:{"content-type":"application/json"}});
  };
  await make({ canSpawn: true, approvalMode: "plan" }).runSubagents([{ title:"child",prompt:"write" }]);
  check("children inherit plan mode", () => assert(!fs.existsSync(path.join(workspace,"blocked.txt"))));
  global.fetch = async () => reply("done");
  const batch = await make({canSpawn:true}).runSubagents(Array.from({length:9},(_,i)=>({title:`task ${i}`,prompt:"hello"})));
  check("in-loop parallel jobs are all returned", () => assert.equal((batch.match(/^## task/gm)||[]).length,9));
  let active=0,max=0;
  const ordered = await mapLimit(Array.from({length:12},(_,i)=>i),3,async i=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;return i;});
  check("queue respects concurrency and input order",()=>{assert.equal(max,3);assert.deepEqual(ordered,Array.from({length:12},(_,i)=>i));});

  const failed = await executeTask({task:"fix",createAgent:async emit=>({lastText:"I will fix it",model:"fixture",send:async()=>{emit("tool_call",{id:"a",name:"write_file",args:{path:"never.txt"}});emit("tool_result",{id:"a",ok:false,result:"error"});emit("error",{message:"step limit"});},abort(){}})});
  check("commentary and failed writes cannot conceal a failed task",()=>{assert.equal(failed.status,"failed");assert.equal(failed.changes.length,0);assert.equal(failed.reason,"step limit");assert.equal(failed.verification.status,"unverified");});
  const nested = await executeTask({task:"fix",createAgent:async emit=>({model:"fixture",send:async()=>{emit("subagent",{kind:"tool_call",subId:"child",payload:{id:"a",name:"write_file",args:{path:"child.txt"}}});emit("subagent",{kind:"tool_result",subId:"child",payload:{id:"a",ok:true}});emit("done",{});},abort(){}})});
  check("successful child writes appear in the parent execution result",()=>assert.equal(nested.changes[0].path,"child.txt"));
  const checked = await executeTask({task:"fix",checks:["test"],createAgent:async emit=>({lastText:"done",model:"fixture",send:async()=>emit("done",{}),abort(){}}),runCheck:async()=>({ok:false,exitCode:1,text:"assertion failed"})});
  check("acceptance failure overrides a claimed completion",()=>{assert.equal(checked.status,"failed");assert.equal(checked.verification.status,"failed");});
  let aborted=false;
  const timeout = await executeTask({task:"wait",timeoutMs:15,createAgent:async()=>({send:()=>new Promise(()=>{}),abort(){aborted=true;}})});
  check("deadline returns partial status and aborts a stalled agent",()=>{assert.equal(timeout.status,"partial");assert(aborted);});
  const ctl = new AbortController();
  const command = executeToolResult("run_command",{command:`"${process.execPath}" -e "setTimeout(()=>{},30000)"`},{workspace,signal:ctl.signal});
  setTimeout(()=>ctl.abort(),50);
  const stopped = await command;
  check("cancellation stops a running shell command",()=>assert.equal(stopped.ok,false));
  check("default chain excludes an arbitrary paid-only entry",()=>assert.deepEqual(providers.suggestChain(["openrouter/anthropic/paid-fixture"]),[]));
  const models=[gatewayModel({id:"openrouter/a:free",supported_parameters:["tools"],context_length:8192}),gatewayModel({id:"openrouter/b",pricing:{prompt:"1",completion:"2"}})];
  check("catalog filters distinguish free, tools, context, and unknown health",()=>{assert.equal(filterModels(models,{free_only:true,tools_only:true}).length,1);assert.equal(models[0].context,8192);assert.equal(models[0].health,"untested");assert.equal(models[1].pricing,"paid");});

  global.fetch = async () => reply("READY");
  const healthy = await probe({baseUrl:"http://fixture.invalid/v1"},"fixture");
  global.fetch = async () => new Response("quota",{status:429});
  const limited = await probe({baseUrl:"http://fixture.invalid/v1"},"fixture");
  check("explicit model checks distinguish an answer from rate limiting",()=>{assert.equal(healthy.health,"responding");assert.equal(limited.health,"rate limited");});

  // Exercise the actual stdio MCP transport and both public delegation tools.
  global.fetch = originalFetch;
  server = http.createServer((req,res)=>{
    let raw="";req.on("data",d=>raw+=d);req.on("end",()=>{
      res.setHeader("content-type","application/json");
      if(req.url.endsWith("/models"))return res.end(JSON.stringify({data:[{id:"fixture",context_length:32000}]}));
      const body=JSON.parse(raw||"{}");
      const task=body.messages?.find(m=>m.role==="user")?.content;
      if(task==="FAIL"){res.statusCode=503;return res.end('{"error":"fixture failure"}');}
      res.end(JSON.stringify({choices:[{message:{role:"assistant",content:"Completed fixture task"}}],usage:{prompt_tokens:10,completion_tokens:4}}));
    });
  });
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  child=spawn(process.execPath,[path.join(__dirname,"../electron/mcp-server.js")],{env:{...process.env,OMNIWORK_NO_PREWARM:"1",OMNIWORK_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`,OMNIWORK_ENGINE_FALLBACK:"off",OMNIWORK_MODEL_FALLBACKS:"",OMNIWORK_DATA_DIR:path.join(workspace,"app-data")},stdio:["pipe","pipe","pipe"]});
  child.stderr.resume();let buffer="",seq=0;const pending=new Map();
  child.stdout.on("data",d=>{buffer+=d;let n;while((n=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const m=JSON.parse(line);pending.get(m.id)?.(m);pending.delete(m.id);}catch{}}});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(new Error("RPC timeout")),10000);pending.set(id,m=>{clearTimeout(timer);resolve(m);});child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");});
  const result=await rpc("tools/call",{name:"delegate_parallel",arguments:{tasks:Array(9).fill("hello"),cwd:workspace,model:"fixture"}});
  check("MCP parallel returns all nine structured results with usage",()=>{assert(!result.result.isError);assert.equal(result.result.structuredContent.tasks.length,9);assert.equal(result.result.structuredContent.tasks[0].usage.inTokens,10);});
  const failure=await rpc("tools/call",{name:"delegate",arguments:{task:"FAIL",cwd:workspace,model:"fixture"}});
  check("MCP transport reports execution failures as errors",()=>{assert.equal(failure.result.isError,true);assert.equal(failure.result.structuredContent.status,"failed");});
  console.log(`\n✅ RELIABILITY TEST PASSED (${assertions} checks)`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  global.fetch=originalFetch;child?.kill();server?.close();fs.rmSync(workspace,{recursive:true,force:true});
});
