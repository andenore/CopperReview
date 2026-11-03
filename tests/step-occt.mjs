// Optional: runs the real STEP reader (occt-import-js, fetched by `npm run build:occt`) on a STEP file and checks
// that the viewer's converter accepts what it returns.
//   node tests/step-occt.mjs path/to/model.step [expected-length-mm expected-width-mm]
// Skips (exit 0) without the reader or a file. This executes third-party WASM, so run it deliberately.
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import assert from 'node:assert/strict';
import {occtToBody} from '../copper_review/web/model3d.js';

const dir=join(dirname(fileURLToPath(import.meta.url)),'..','copper_review','web','occt');
const [file,length,width]=process.argv.slice(2);
if(!existsSync(join(dir,'occt-import-js.wasm'))){console.log('skip: run `npm run build:occt` first');process.exit(0);}
if(!file||!existsSync(file)){console.log('skip: pass a STEP file');process.exit(0);}

const occtimportjs=createRequire(import.meta.url)(join(dir,'occt-import-js.js'));
const occt=await occtimportjs({locateFile:name=>join(dir,name)});
const started=Date.now();
const result=occt.ReadStepFile(new Uint8Array(readFileSync(file)),{linearUnit:'millimeter',linearDeflectionType:'bounding_box_ratio',linearDeflection:.001,angularDeflection:.5});
assert.ok(result.success,'the STEP file was read');
const body=occtToBody({meshes:result.meshes.map(mesh=>({
  name:mesh.name||'',color:mesh.color||null,
  position:Float32Array.from(mesh.attributes.position.array),index:Uint32Array.from(mesh.index.array),
  faces:(mesh.brep_faces||[]).map(face=>({first:face.first,last:face.last,color:face.color||null})),
}))});
assert.equal(body.unit,1);
assert.ok(body.parts.length>0);
const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
let triangles=0;
for(const part of body.parts){
  triangles+=part.triangles.length/3;
  for(const i of part.triangles)for(let a=0;a<3;a++){const v=part.points[i*3+a];min[a]=Math.min(min[a],v);max[a]=Math.max(max[a],v);}
}
assert.ok(triangles>0&&[...min,...max].every(Number.isFinite));
const size=max.map((v,a)=>v-min[a]);
console.log(`ok: ${body.parts.length} parts, ${triangles} triangles in ${Date.now()-started} ms; size ${size.map(v=>v.toFixed(2)).join(' x ')} mm`);
if(length&&width){
  const [a,b]=[...size.slice(0,2)].sort((x,y)=>y-x),[expectedA,expectedB]=[Number(length),Number(width)].sort((x,y)=>y-x);
  assert.ok(Math.abs(a-expectedA)<.5&&Math.abs(b-expectedB)<.5,`footprint ${a.toFixed(2)} x ${b.toFixed(2)} mm, expected about ${expectedA} x ${expectedB}`);
}
