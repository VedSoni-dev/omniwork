const fs=require('fs'),os=require('os'),path=require('path');
const {Gateway}=require('../electron/sidecar');const {SessionManager}=require('../electron/sessions');const {MCPManager}=require('../electron/mcp');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ow-p-'));const ws=fs.mkdtempSync(path.join(os.tmpdir(),'ow-pw-'));
  const pp=path.join(dataDir,'sessions.json');
  const gw=new Gateway({dataDir,onStatus:s=>console.log(`[gw:${s.state}]`)});await gw.start();
  const mcp=new MCPManager(dataDir);
  const mk=()=>new SessionManager({gateway:gw,mcp,persistPath:pp,emit:()=>{}});

  const sm1=mk();
  const a=sm1.create({workspace:ws,title:'Persisted'});
  console.log('created session',a.id);
  await sm1.send(a.id,'Create a file p.txt containing exactly "kept". Then stop.');
  sm1.save(); await wait(700); // let debounced save flush
  console.log('saved. file on disk:',fs.existsSync(pp));

  console.log('\n--- new manager, restore ---');
  const sm2=mk();
  const n=sm2.restore();
  const restored=sm2.list();
  const t=sm2.transcript(a.id);
  const msgs=sm2.sessions.get(a.id)?.agent.messages.length;
  console.log('restored count:',n,'| titles:',restored.map(s=>s.title).join(','),'| transcript items:',t.length,'| agent msgs:',msgs);
  const userLine=t.find(e=>e.type==='user');
  console.log('has user line in transcript:',!!userLine);

  gw.stop();
  const ok=n===1 && restored[0].title==='Persisted' && t.length>0 && msgs>1 && !!userLine;
  console.log('\n'+(ok?'✅ PERSISTENCE TEST PASSED':'❌ FAILED'));
  process.exit(ok?0:1);
})().catch(e=>{console.error('crash',e);process.exit(1)});
