#!/usr/bin/env node
"use strict";
// Real installed engine, synthetic LOCAL inference. Saves counts, never prompt text.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { Engine, OpenCodeAgent } = require('../electron/opencode-engine');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-prompt-'));
const rows = []; let profile, engine;
const marker = 'PROJECT_RULE_KEEP_COMPATIBILITY_7F41';
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const b = JSON.parse(raw || '{}');
  const system = (b.messages || []).filter(m=>['system','developer'].includes(m.role)).map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
  rows.push({profile, systemChars:system.length, toolSchemaChars:JSON.stringify(b.tools||[]).length, messageChars:JSON.stringify(b.messages||[]).length, tools:(b.tools||[]).map(t=>t.function?.name), preservesProjectRule:system.includes(marker), hasFixtureSkill:system.includes('fixture-skill-00')});
  const packet = {id:'local-probe',object:'chat.completion.chunk',created:1,model:'coder',choices:[{index:0,delta:{role:'assistant',content:'READY'},finish_reason:null}]};
  if(b.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify(packet)+'\n\n');res.write('data: '+JSON.stringify({...packet,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:1,total_tokens:101}})+'\n\n');res.end('data: [DONE]\n\n');}
  else {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...packet,choices:[{index:0,message:{role:'assistant',content:'READY'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:1,total_tokens:101}}));}
});
(async()=>{
  fs.writeFileSync(path.join(root,'AGENTS.md'),marker+'\n');
  for(let i=0;i<20;i++){const name='fixture-skill-'+String(i).padStart(2,'0'),dir=path.join(root,'.opencode','skills',name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'SKILL.md'),`---\nname: ${name}\ndescription: Synthetic skill for an unrelated workflow used to measure catalog overhead.\n---\nDo the unrelated workflow.\n`);}
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({enabled_providers:['fixture'],small_model:'fixture/coder',provider:{fixture:{npm:'@ai-sdk/openai-compatible',name:'Local fixture',options:{baseURL:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fixture'},models:{coder:{name:'Local fixture',limit:{context:100000,output:2048},tool_call:true}}}}});
  engine=new Engine();await engine.start();await engine.models();
  for(profile of ['standard','focused','scoped']){
    const errors=[];const a=new OpenCodeAgent({engine,workspace:root,model:'opencode/fixture/coder',engineProfile:profile,emit:(t,p)=>{if(t==='error')errors.push(p.message);}});
    await a.send('Reply READY. Do not use tools.');if(errors.length)throw Error(errors.join('; '));
  }
  if(rows.length!==3)throw Error(`Expected three requests, got ${rows.length}`);
  if(!rows.every(r=>r.preservesProjectRule))throw Error('Lost project instructions');
  if(!rows[0].hasFixtureSkill||rows.slice(1).some(r=>r.hasFixtureSkill))throw Error('Skill catalog was not filtered');
  if(rows.slice(1).some(r=>r.tools.some(t=>['task','skill','question'].includes(t))))throw Error('Focused worker exposed unrelated tools');
  const report={scope:'Real OpenCode HTTP requests to a local synthetic inference server; character counts, not token estimates',rows,reduction:Object.fromEntries(rows.slice(1).map(r=>[r.profile,1-(r.messageChars+r.toolSchemaChars)/(rows[0].messageChars+rows[0].toolSchemaChars)]))};
  const i=process.argv.indexOf('--output');if(i>=0)fs.writeFileSync(process.argv[i+1],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{engine?.stop();server.closeAllConnections();server.close();fs.rmSync(root,{recursive:true,force:true});});
