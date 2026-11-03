/* Classic worker (occt-import-js is a UMD script, not a module). It exists only after `npm run build:occt`
   and is started the first time a STEP model has to be drawn. */
importScripts('./occt/occt-import-js.js');

let ready=null;
self.onmessage=async event=>{
  const {id,bytes}=event.data;
  try{
    ready||=occtimportjs({locateFile:name=>new URL(`./occt/${name}`,self.location.href).href});
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
