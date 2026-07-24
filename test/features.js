const fs=require('fs'),os=require('os'),path=require('path');
const {Gateway}=require('../electron/sidecar');const {Agent}=require('../electron/agent');const {MCPManager}=require('../electron/mcp');
(async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ow-f-'));const ws=fs.mkdtempSync(path.join(os.tmpdir(),'ow-fw-'));
  const gw=new Gateway({dataDir,onStatus:s=>console.log(`[gw:${s.state}]`)});await gw.start();
  const mcp=new MCPManager(dataDir);

  // A) streaming + undo
  let deltas=0;
  const a=new Agent({baseUrl:gw.baseUrl,apiKey:gw.apiKey,model:'auto',workspace:ws,mcp,emit:(t)=>{if(t==='assistant_delta')deltas++;}});
  console.log('\n--- A: streaming + undo ---');
  await a.send('Create a file note.txt containing exactly "hello". Then stop.');
  const created=fs.existsSync(path.join(ws,'note.txt'));
  console.log('assistant_delta events:',deltas,'| note.txt created:',created,'| undoAvailable:',a.undoAvailable);
  const undoMsg=a.undo();
  const afterUndo=fs.existsSync(path.join(ws,'note.txt'));
  console.log('undo:',JSON.stringify(undoMsg),'| note.txt after undo:',afterUndo);

  // B) approval gate (deny)
  console.log('\n--- B: approval (deny writes) ---');
  let asked=[];
  const b=new Agent({baseUrl:gw.baseUrl,apiKey:gw.apiKey,model:'auto',workspace:ws,mcp,approvalMode:'ask',
    approver:async(id,name,args)=>{asked.push(name);return false;/*deny*/},emit:()=>{}});
  await b.send('Create a file blocked.txt containing "x". Then stop.');
  const blocked=fs.existsSync(path.join(ws,'blocked.txt'));
  console.log('approver asked for:',asked.join(',')||'(none)','| blocked.txt created:',blocked);

  gw.stop();
  const ok = deltas>1 && created && !afterUndo && asked.includes('write_file') && !blocked;
  console.log('\n'+(ok?'✅ FEATURES TEST PASSED (streaming + undo + approval)':'❌ FAILED'));
  process.exit(ok?0:1);
})().catch(e=>{console.error('crash',e);process.exit(1)});
