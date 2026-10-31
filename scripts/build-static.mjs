import {readFileSync,writeFileSync,mkdirSync,readdirSync,copyFileSync,statSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),web=join(root,'copper_review','web'),out=join(root,'dist');
const manifest=JSON.parse(readFileSync(join(web,'wasm','manifest.json')));
for(const [file,key]of [['copper_web_bg.wasm','wasm_sha256'],['copper_web.js','bindings_sha256']])if(createHash('sha256').update(readFileSync(join(web,'wasm',file))).digest('hex')!==manifest[key])throw Error(`Stale WASM asset: ${file}`);
function copy(from,to){mkdirSync(to,{recursive:true});for(const name of readdirSync(from)){const source=join(from,name),target=join(to,name);if(statSync(source).isDirectory())copy(source,target);else copyFileSync(source,target);}}
copy(web,out);writeFileSync(join(out,'.nojekyll'),'');console.log(`Static CopperReview: ${out}`);
