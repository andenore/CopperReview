import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256} from '../copper_review/web/hash.js';

// A stub reader: the worker answers each job when told, so the test controls which one is slow.
const script=new TextEncoder().encode('reader'),wasm=new Uint8Array([0,97,115,109]);
const manifest={js_sha256:await sha256(script),wasm_sha256:await sha256(wasm)};
const files={'manifest.json':new TextEncoder().encode(JSON.stringify(manifest)),'occt-import-js.js':script,'occt-import-js.wasm':wasm};
globalThis.fetch=async url=>{const body=files[String(url).split('/').pop()];return {ok:!!body,arrayBuffer:async()=>body.slice().buffer};};
const workers=[];
globalThis.Worker=class{constructor(){this.jobs=[];this.terminated=false;workers.push(this);}
  postMessage(message){if(message.id)this.jobs.push(message.id);}
  answer(id){this.onmessage({data:{id,result:{meshes:[{position:new Float32Array([0,0,0,1,0,0,0,1,0]),index:new Uint32Array([0,1,2])}]}}});}
  terminate(){this.terminated=true;}};
const {readStep}=await import('../copper_review/web/steps.js');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
// Waits for the stub to reach a state, however long hashing takes under a busy test run.
const until=async ready=>{for(let i=0;i<10000&&!ready();i++)await settle();assert.ok(ready(),'the STEP queue did not reach the expected state');};

test('STEP files are read one at a time, each timed from its own start; a slow one costs only itself',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const outcome=p=>p.then(()=>'ok',e=>e.message);
  const jobs=[1,2,3].map(()=>outcome(readStep(new ArrayBuffer(4))));
  await until(()=>workers[0]?.jobs.length);
  const first=workers[0];assert.deepEqual(first.jobs,[1],'only the first file is sent');
  // Waiting in the queue does not count: 50 s pass while job 1 runs, then it finishes.
  t.mock.timers.tick(50000);first.answer(1);await until(()=>first.jobs.length===2);assert.deepEqual(first.jobs,[1,2]);
  t.mock.timers.tick(50000);first.answer(2);await until(()=>first.jobs.length===3);
  // Job 3 hangs: it alone times out, and the worker is replaced.
  t.mock.timers.tick(60000);await settle();
  assert.deepEqual(await Promise.all(jobs),['ok','ok','Reading a STEP file took too long.']);
  assert.ok(first.terminated);
  const after=outcome(readStep(new ArrayBuffer(4)));await until(()=>workers[1]?.jobs.length);
  assert.equal(workers.length,2);workers[1].answer(workers[1].jobs[0]);assert.equal(await after,'ok');
});
