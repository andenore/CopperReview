/* CopperScript generates the fallback 3D bodies; they come from the same WASM build as the compiler. */
// Loading the compiler and generating are timed apart; generating gets more time per footprint.
const LOAD_MS=30000,GENERATE_MS=30000,PER_BODY_MS=50;
export function generateBodies(requests) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./body-worker.js',import.meta.url),{type:'module'});
    let timer=setTimeout(()=>finish(Error('CopperScript WASM took too long to load.')),LOAD_MS);
    function finish(error,value){clearTimeout(timer);worker.terminate();if(error)reject(error);else resolve(value);}
    worker.onerror=event=>{event.preventDefault();finish(Error(event.message||'Could not load CopperScript WASM.'));};
    worker.onmessage=event=>{
      const msg=event.data;
      if(msg.type==='ready'){clearTimeout(timer);timer=setTimeout(()=>finish(Error('CopperScript took too long to generate 3D bodies.')),GENERATE_MS+PER_BODY_MS*requests.length);worker.postMessage({requests});}
      else if(msg.type==='bodies')finish(null,msg.results);
      else if(msg.type==='fatal')finish(Error(msg.error));
    };
  });
}
