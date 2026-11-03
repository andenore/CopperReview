/* CopperScript generates the fallback 3D bodies; they come from the same WASM build as the compiler. */
const LIMIT_MS=30000;
export function generateBodies(requests) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./body-worker.js',import.meta.url),{type:'module'});
    const timer=setTimeout(()=>finish(Error('CopperScript took too long to generate 3D bodies.')),LIMIT_MS);
    function finish(error,value){clearTimeout(timer);worker.terminate();if(error)reject(error);else resolve(value);}
    worker.onerror=event=>{event.preventDefault();finish(Error(event.message||'Could not load CopperScript WASM.'));};
    worker.onmessage=event=>{
      const msg=event.data;
      if(msg.type==='ready')worker.postMessage({requests});
      else if(msg.type==='bodies')finish(null,msg.results);
      else if(msg.type==='fatal')finish(Error(msg.error));
    };
  });
}
