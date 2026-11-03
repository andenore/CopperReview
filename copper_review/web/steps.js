/* STEP files are read by occt-import-js in a replaceable classic worker; files stay local. */
import {occtToBody} from './model3d.js';
import {sha256} from './hash.js';

const LIMIT_MS=60000;
let worker=null,counter=0,running=null,verified=null;
const queue=[];

// One file at a time, each timed from when it starts: a queue of many models never times out
// as a whole, and one file that takes too long costs only itself (the worker restarts for the rest).
function stop() {worker?.terminate();worker=null;}
// The reader's script and WASM must match the manifest build:occt wrote, as body-worker.js checks the
// compiler; the worker gets the checked WASM bytes and loads the script only after this.
async function verify() {
  const get=async name=>{const response=await fetch(new URL(`./occt/${name}`,import.meta.url));if(!response.ok)throw Error('The STEP reader is not built. Run `npm run build:occt`.');return response.arrayBuffer();};
  const manifest=JSON.parse(new TextDecoder().decode(await get('manifest.json')));
  const [script,wasm]=await Promise.all([get('occt-import-js.js'),get('occt-import-js.wasm')]);
  if(await sha256(script)!==manifest.js_sha256||await sha256(wasm)!==manifest.wasm_sha256)throw Error('The STEP reader does not match its build manifest. Run `npm run build:occt` again.');
  return wasm;
}
function fail(error) {
  if(running){clearTimeout(running.timer);running.reject(error);running=null;}
  for(const job of queue.splice(0))job.reject(error);
  stop();
}
async function next() {
  if(running||!queue.length)return;
  if(!worker){
    try{verified||=verify();const wasm=(await verified).slice(0);if(running||!queue.length||worker)return next();start(wasm);}
    catch(error){verified=null;fail(error);return;}
  }
  running=queue.shift();
  running.timer=setTimeout(()=>{const job=running;running=null;stop();job.reject(Error('Reading a STEP file took too long.'));next();},LIMIT_MS);
  worker.postMessage({id:running.id,bytes:running.bytes},[running.bytes]);
}
function start(wasm) {
  worker=new Worker(new URL('./step-worker.js',import.meta.url));
  worker.postMessage({wasm},[wasm]);
  worker.onmessage=event=>{
    const {id,error,result}=event.data,job=running;
    if(!job||job.id!==id)return;
    running=null;clearTimeout(job.timer);
    if(error)job.reject(Error(error));else job.resolve(result);
    next();
  };
  worker.onerror=event=>{
    // The reader cannot load at all: fail what is waiting instead of retrying each file.
    event.preventDefault();fail(Error(event.message?`The STEP reader failed: ${event.message}`:'The STEP reader could not start.'));
  };
}

/** A body (millimetres) from the bytes of a STEP file. */
export function readStep(bytes) {
  return new Promise((resolve,reject)=>{
    queue.push({id:++counter,bytes,reject,resolve:result=>{try{resolve(occtToBody(result));}catch(error){reject(error);}}});
    next();
  });
}
