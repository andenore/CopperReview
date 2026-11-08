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
// TI's X2QFN-12 (1.6 mm body, pad centres 0.025 mm past it): a no-lead body with edge terminals and a pin-1 mark.
const x2qfn={schema:'copperscript.body-input/v1',name:'Texas_X2QFN-12_1.6x1.6mm_P0.4mm',fab_mm:[-.8,-.8,.8,.8],
  pads:[...[-.2,.2].flatMap((y,i)=>[{number:String(i+1),x_mm:-.725,y_mm:y,w_mm:.85,h_mm:.2,kind:'smd'},{number:String(8-i),x_mm:.725,y_mm:y,w_mm:.85,h_mm:.2,kind:'smd'}]),
        ...[-.6,-.2,.2,.6].flatMap((x,i)=>[{number:String(3+i),x_mm:x,y_mm:.825,w_mm:.2,h_mm:.65,kind:'smd'},{number:String(12-i),x_mm:x,y_mm:-.825,w_mm:.2,h_mm:.65,kind:'smd'}])]};
const qfn=JSON.parse(wasm.generate_body(JSON.stringify(x2qfn)));
assert.equal(qfn.kind,'no_lead');
assert.deepEqual(parseVrml(qfn.wrl).parts.map(p=>p.name),['body','terminals','pin1']);
// A side-entry wire-to-board header marked as a connector: a nylon block at its height with contacts on the pads.
const header={schema:'copperscript.body-input/v1',name:'JST_S3B-XH-SM4-TB',body_kind:'connector',height_mm:6,fab_mm:[-6.25,-4,6.25,3],
  pads:[...[-2.5,0,2.5].map((x,i)=>({number:String(i+1),x_mm:x,y_mm:2.2,w_mm:1,h_mm:3.5,kind:'smd'})),
        ...[-5.2,5.2].map(x=>({number:'MP',x_mm:x,y_mm:-2.5,w_mm:1.6,h_mm:3,kind:'smd'}))]};
const connector=JSON.parse(wasm.generate_body(JSON.stringify(header)));
assert.equal(connector.kind,'connector');
assert.deepEqual(parseVrml(connector.wrl).parts.map(p=>p.name),['body','contacts']);
assert.equal(JSON.parse(wasm.generate_body(JSON.stringify({...header,body_kind:undefined}))).kind,'no_lead');
console.log('ok: generate_body gives a leaded SOIC-8, a no-lead X2QFN-12 and a connector the viewer can parse');
