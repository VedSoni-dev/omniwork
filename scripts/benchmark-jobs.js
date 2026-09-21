#!/usr/bin/env node
"use strict";
// Explicit live acceptance benchmark. Uses only a catalog-confirmed free model,
// a disposable repository and isolated app data; no project credentials copied.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { git } = require("../electron/job-workspace");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const args = process.argv.slice(2);
if (!args.includes("--live")) { console.log("Usage: node scripts/benchmark-jobs.js --live [--model opencode/big-pickle] [--output report.json]"); process.exit(0); }
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
const model = value("--model", "opencode/big-pickle");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-acceptance-")), repo = path.join(root, "repo");
process.env.OMNIWORK_DATA_DIR = path.join(root, "data");
const client = require("../electron/job-client");
const tasks = [
  {
    file: "slug.cjs", task: "Implement module.exports = slug in slug.cjs. slug takes a string, normalizes accents using NFKD, removes combining marks, lowercases ASCII letters, replaces each run of non-ASCII-alphanumeric characters with one hyphen, removes leading/trailing hyphens, and returns an empty string for empty input. Leave tests unchanged.",
    tests: "const slug=require('../slug.cjs');assert.equal(slug('  Café Déjà VU! '),'cafe-deja-vu');assert.equal(slug('a___b / c'),'a-b-c');assert.equal(slug('!!!'),'');assert.equal(slug('ABC123'),'abc123');assert.equal(slug(''),'');",
  },
  {
    file: "range.cjs", task: "Fix range.cjs, exporting module.exports = range. range(start, end, step=1) returns an end-exclusive numeric range, supports negative steps, returns [] when the step points away from the end or start===end, throws RangeError for step===0 and for any non-finite argument. Leave tests unchanged.",
    tests: "const range=require('../range.cjs');assert.deepEqual(range(1,5),[1,2,3,4]);assert.deepEqual(range(5,0,-2),[5,3,1]);assert.deepEqual(range(5,0),[]);assert.deepEqual(range(1,5,-1),[]);assert.deepEqual(range(2,2),[]);assert.throws(()=>range(0,5,0),RangeError);assert.throws(()=>range(0,Infinity),RangeError);",
  },
  {
    file: "parse.cjs", task: "Implement module.exports = parse in parse.cjs. Parse comma-separated assignments of key=value, splitting each assignment at its FIRST equals sign, trimming keys/values, skipping empty comma-separated items. Return a null-prototype object. Reject an item without '=', an empty key, duplicate keys, and keys __proto__, constructor, prototype with Error. An empty string returns an empty null-prototype object. Leave tests unchanged.",
    tests: "const parse=require('../parse.cjs');const r=parse(' a = 1, b=x=y ,,');assert.equal(Object.getPrototypeOf(r),null);assert.equal(r.a,'1');assert.equal(r.b,'x=y');assert.equal(Object.keys(parse('')).length,0);for(const s of ['bad','=x','x=1,x=2','__proto__=x','constructor=x','prototype=x'])assert.throws(()=>parse(s));",
  },
];
(async()=>{
  fs.mkdirSync(repo);fs.mkdirSync(path.join(repo,"tests"));
  await git(repo,["init","-q"]);await git(repo,["config","user.email","benchmark@localhost"]);await git(repo,["config","user.name","OmniWork Benchmark"]);
  for(const t of tasks){fs.writeFileSync(path.join(repo,t.file),'module.exports = () => { throw new Error("Implement me"); };\n');fs.writeFileSync(path.join(repo,"tests",t.file),`const assert=require('node:assert/strict');\n${t.tests}\n`);}
  await git(repo,["add","."]);await git(repo,["commit","-qm","acceptance fixtures"]);
  await client.ensure(); const began=Date.now();
  const submitted=await client.call("submit",{tasks:tasks.map(t=>({cwd:repo,model,task:t.task,allowed_paths:[t.file],context_files:[t.file,`tests/${t.file}`],checks:[`node tests/${t.file}`],timeout_ms:120000,max_tokens:250000,repair_attempts:1}))});
  const submissionMs=Date.now()-began;
  const pending=new Set(submitted.jobs.map(j=>j.id));
  const end=Date.now()+210000;
  while(pending.size && Date.now()<end){const state=await client.call("wait",{ids:[...pending],timeout_ms:25000});for(const j of state.jobs)if(["completed","partial","failed","cancelled","interrupted"].includes(j.status)){pending.delete(j.id);console.log(j.id,j.status,j.reason||"");}}
  for(const id of pending)await client.call("cancel",{id});
  const jobs=[];
  for(const j of submitted.jobs){const detail=await client.call("get",{id:j.id,detail:true});let integration=null;if(detail.status==="completed")integration=await client.call("apply",{id:j.id});jobs.push({id:j.id,status:detail.status,reason:detail.reason,model:detail.model?.id,result:detail.result,files:detail.artifact?.files,integration});}
  let allChecksPass=true;for(const t of tasks){try{await exec(process.execPath,[`tests/${t.file}`],{cwd:repo,timeout:10000});}catch{allChecksPass=false;}}
  const report={testedAt:new Date().toISOString(),model,scope:"Three small coding fixtures with caller-owned acceptance checks; not a production-quality or competitive benchmark",submissionMs,elapsedMs:Date.now()-began,allChecksPass,jobs};
  const out=value("--output",null);if(out)fs.writeFileSync(out,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({submissionMs,elapsedMs:report.elapsedMs,allChecksPass,passed:jobs.filter(j=>j.status==="completed").length,total:jobs.length},null,2));
  if(!allChecksPass)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await client.call("stop").catch(()=>{});await new Promise(r=>setTimeout(r,500));fs.rmSync(root,{recursive:true,force:true});});
