// Optional: needs `npm run build:wasm` from a CopperScript that exports generate_body. Skips otherwise.
import {readFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {parseVrml} from '../copper_review/web/model3d.js';
const dir=join(dirname(fileURLToPath(import.meta.url)),'..','copper_review','web','wasm');
if(!existsSync(join(dir,'copper_web_bg.wasm'))){console.log('skip: WASM not built');process.exit(0);}
const wasm=await import('../copper_review/web/wasm/copper_web.js');
await wasm.default({module_or_path:readFileSync(join(dir,'copper_web_bg.wasm'))});
if(typeof wasm.generate_body!=='function'){console.log('skip: this WASM build has no generate_body');process.exit(0);}
const soic={schema:'copperscript.body-input/v1',name:'SOIC-8',fab_mm:[-1.95,-2.45,1.95,2.45],
  pads:[...Array(4).keys()].flatMap(i=>[-1,1].map(side=>({number:String(i*2+(side<0?1:2)),x_mm:side*2.475,y_mm:-1.905+1.27*i,w_mm:1.95,h_mm:.6,kind:'smd'})))};
const result=JSON.parse(wasm.generate_body(JSON.stringify(soic)));
assert.equal(result.schema,'copperscript.body/v1');assert.equal(result.kind,'leaded');assert.equal(result.approximate,true);
const {parts}=parseVrml(result.wrl);
assert.deepEqual(parts.map(p=>p.name),['body','leads']);
const xs=[...parts[0].points].filter((_,i)=>i%3===0);
assert.ok(Math.abs(Math.min(...xs)+1.95)<1e-5&&Math.abs(Math.max(...xs)-1.95)<1e-5,'body spans the 3.9 mm fabrication outline');
assert.ok(JSON.parse(wasm.generate_body('{}')).error);
console.log('ok: generate_body gives a leaded SOIC-8 body the viewer can parse');
