const fs=require('fs'),os=require('os'),path=require('path');
const {SessionManager}=require('../electron/sessions');const {MCPManager}=require('../electron/mcp');
const {ProjectManager}=require('../electron/projects');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ow-p-'));const ws=fs.mkdtempSync(path.join(os.tmpdir(),'ow-pw-'));
  // Persistence has no provider dependency. Keep CI and local runs offline.
  const gw={baseUrl:'http://fixture.invalid/v1',apiKey:'fixture'};
  global.fetch=async (_url,opts={})=>{
    if (!opts.body) return new Response(JSON.stringify({data:[{id:'fixture',context_length:32000}]}));
    const b=JSON.parse(opts.body);
    const message=b.messages.some(m=>m.role==='tool')
      ? {role:'assistant',content:'Created p.txt.'}
      : {role:'assistant',content:'',tool_calls:[{id:'persist-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'p.txt',content:'kept'})}}]};
    return new Response(JSON.stringify({choices:[{message}],usage:{prompt_tokens:20,completion_tokens:10}}),{headers:{'content-type':'application/json'}});
  };
  const mcp=new MCPManager(dataDir);
  // Fresh ProjectManager per manager = a real restart against the same disk state.
  const mk=()=>new SessionManager({gateway:gw,mcp,projects:new ProjectManager(path.join(dataDir,'projects')),
    globalMemoryDir:path.join(dataDir,'memory'),legacyPath:path.join(dataDir,'sessions.json'),emit:()=>{}});

  const sm1=mk();
  const a=sm1.create({workspace:ws,title:'Persisted'});
  console.log('created session',a.id,'in project',a.projectId);
  await sm1.send(a.id,'Create a file p.txt containing exactly "kept". Then stop.');
  sm1.save(); await wait(700); // let debounced save flush
  const sessFile=path.join(dataDir,'projects',a.projectId,'sessions',a.id+'.json');
  console.log('saved. per-session file on disk:',fs.existsSync(sessFile));

  console.log('\n--- new manager, restore ---');
  const sm2=mk();
  const n=sm2.restore();
  const restored=sm2.list();
  const t=sm2.transcript(a.id);
  const msgs=sm2.sessions.get(a.id)?.agent.messages.length;
  console.log('restored count:',n,'| titles:',restored.map(s=>s.title).join(','),'| project:',restored[0]?.projectName,'| transcript items:',t.length,'| agent msgs:',msgs);
  const userLine=t.find(e=>e.type==='user');
  console.log('has user line in transcript:',!!userLine);

  const ok=n===1 && restored[0].title==='Persisted' && restored[0].projectId===a.projectId && t.length>0 && msgs>1 && !!userLine && fs.readFileSync(path.join(ws,'p.txt'),'utf8')==='kept';
  console.log('\n'+(ok?'✅ PERSISTENCE TEST PASSED':'❌ FAILED'));
  fs.rmSync(dataDir,{recursive:true,force:true});fs.rmSync(ws,{recursive:true,force:true});
  process.exit(ok?0:1);
})().catch(e=>{console.error('crash',e);process.exit(1)});
