/* Classic worker (occt-import-js is a UMD script, not a module). It exists only after `npm run build:occt`
   and is started the first time a STEP model has to be drawn. steps.js checks the reader against its
   build manifest first and sends the checked WASM as the first message. */
let ready=null;
self.onmessage=async event=>{
  if(event.data.wasm){
    const wasmBinary=event.data.wasm;
    ready=(async()=>{importScripts('./occt/occt-import-js.js');return occtimportjs({wasmBinary});})();
    ready.catch(()=>{});
    return;
  }
  const {id,bytes}=event.data;
  try{
    if(!ready)throw Error('The STEP reader was not started.');
    const occt=await ready;
    const result=occt.ReadStepFile(new Uint8Array(bytes),{linearUnit:'millimeter',linearDeflectionType:'bounding_box_ratio',linearDeflection:.001,angularDeflection:.5});
    if(!result||!result.success)throw Error('The STEP file could not be read.');
    const meshes=result.meshes.map(mesh=>({
      name:mesh.name||'',color:mesh.color||null,
      position:Float32Array.from(mesh.attributes.position.array),index:Uint32Array.from(mesh.index.array),
      faces:(mesh.brep_faces||[]).map(face=>({first:face.first,last:face.last,color:face.color||null})),
    }));
    const transfer=meshes.flatMap(mesh=>[mesh.position.buffer,mesh.index.buffer]);
    self.postMessage({id,result:{meshes}},transfer);
  }catch(error){self.postMessage({id,error:error.message||String(error)});}
};
