/* Native CopperScript runs in a bounded, replaceable worker; files stay local. */
import {sha256} from './hash.js';
export {sha256};
export async function electricalInput(bytes,filename){
  const ir=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(ir.schema!=='copperscript-ir/v0.1'||ir.kind!=='board')throw Error('Expected CopperScript electrical board IR.');
  return {schema:'copper-review-electrical/v1',input:{filename,sha256:await sha256(bytes)},ir};
}
let current=null;
export function cancelCompiler(){if(current)current.cancel();}
export function compileSource(source){
  if(new TextEncoder().encode(source).length>524288)return Promise.reject(Error('The browser compiler accepts at most 512 KiB of self-contained source.'));
  return runCompiler({source});
}
export function compileProject(snapshot,resolve,{signal,onProgress=()=>{}}={}){
  return runCompiler({project:JSON.stringify(snapshot)},{signal,onProgress,resolve:async (requests,options)=>{await resolve(requests,options);return {project:JSON.stringify(snapshot)};}});
}
function runCompiler(payload,{signal,resolve:resolveSources,onProgress=()=>{}}={}){
  cancelCompiler();
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason);return;}
    const work=new AbortController(),worker=new Worker(new URL('./compiler-worker.js',import.meta.url),{type:'module'});let timer,deadline,finished=false,rounds=0,stage='loading the compiler worker';
    const project=!!payload.project;
    const abort=()=>finish(signal.reason||Error('Compilation cancelled.'));
    const pending={cancel:()=>finish(Error('Compilation cancelled.'))};current=pending;
    signal?.addEventListener('abort',abort,{once:true});
    function finish(error,value){if(finished)return;finished=true;work.abort(error||Error('Compilation complete.'));clearTimeout(timer);clearTimeout(deadline);signal?.removeEventListener('abort',abort);worker.terminate();if(current===pending)current=null;error?reject(error):resolve(value);}
    function send(value){if(finished)return;clearTimeout(timer);timer=setTimeout(()=>finish(Error(`CopperScript analysis exceeded its ${project?60:30}-second limit.`)),project?60000:30000);worker.postMessage(value);}
    timer=setTimeout(()=>finish(Error(`CopperScript WASM loading timed out while ${stage}.${stage==='starting WebAssembly'?' This browser may block WebAssembly on this address (for example Edge enhanced security); allow the site or open it on the server computer.':''}`)),60000);
    if(project)deadline=setTimeout(()=>finish(Error('Project resolution exceeded its 300-second limit.')),300000);
    worker.onerror=event=>{event.preventDefault();finish(Error(event.message||'Could not load CopperScript WASM.'));};
    worker.onmessage=async event=>{
      const msg=event.data;
      if(msg.type==='stage'){stage=msg.stage;onProgress(`Loading CopperScript: ${msg.stage}…`);}
      else if(msg.type==='ready'){onProgress('Checking source and dependencies with CopperScript…');send(payload);}
      else if(msg.type==='result'){
        clearTimeout(timer);
        if(msg.result.schema==='copperscript.project-plan/v1'){
          if(!resolveSources||++rounds>32){finish(Error('Project dependency expansion exceeded its limit.'));return;}
          try{const next=await resolveSources(msg.result.requests,{signal:work.signal});if(!finished){onProgress('Checking resolved source with CopperScript…');send(next);}}catch(error){finish(error);}
        }else finish(null,{...msg.result,compiler:msg.manifest});
      }else if(msg.type==='fatal')finish(Error(msg.error));
    };
  });
}
export async function compileInput(bytes,filename){
  const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes),analysis=await compileSource(source);
  return compiledInput(analysis,bytes,filename);
}
export async function compiledInput(analysis,bytes,filename){
  if(analysis.schema!=='copperscript.review-analysis/v1')throw Error('The WASM compiler does not support the review API.');
  if(!analysis.electrical_ir){const findings=analysis.check?.diagnostics||[];throw Error(findings.slice(0,5).map(d=>`${d.code}: ${d.message}`).join('\n')||'Source could not be compiled.');}
  const result=await electricalInput(new TextEncoder().encode(analysis.electrical_ir),filename.replace(/\.copper$/i,'')+'.ir.json');
  result.input.source={filename,sha256:await sha256(bytes)};result.input.compiler=analysis.compiler;result.analysis=analysis;return result;
}
