/* STEP files are read by occt-import-js in a replaceable classic worker; files stay local. */
import {occtToBody} from './model3d.js';

const LIMIT_MS=60000;
let worker=null,counter=0;
const pending=new Map();

function reset(error) {
  for(const job of pending.values()){clearTimeout(job.timer);job.reject(error);}
  pending.clear();
  worker?.terminate();worker=null;
}

function start() {
  worker=new Worker(new URL('./step-worker.js',import.meta.url));
  worker.onmessage=event=>{
    const {id,error,result}=event.data,job=pending.get(id);
    if(!job)return;
    pending.delete(id);clearTimeout(job.timer);
    if(error)job.reject(Error(error));else job.resolve(result);
  };
  worker.onerror=event=>{event.preventDefault();reset(Error('The STEP reader is not built. Run `npm run build:occt`.'));};
}

/** A body (millimetres) from the bytes of a STEP file. */
export function readStep(bytes) {
  return new Promise((resolve,reject)=>{
    if(!worker)start();
    const id=++counter;
    const timer=setTimeout(()=>reset(Error('Reading a STEP file took too long.')),LIMIT_MS);
    pending.set(id,{timer,reject,resolve:result=>{try{resolve(occtToBody(result));}catch(error){reject(error);}}});
    worker.postMessage({id,bytes},[bytes]);
  });
}
