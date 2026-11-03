/* Download the browser compiler that GitHub Pages built from .copperscript-version, instead of
 * building it locally (which needs Rust, wasm-bindgen 0.2.130 and a CopperScript checkout).
 * The files must match the pinned compiler commit and the hashes in their build manifest. */
import {readFileSync,writeFileSync,mkdirSync,renameSync,rmSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=join(root,'copper_review','web','wasm');
const base=(process.env.COPPER_REVIEW_WASM_URL||'https://andenore.github.io/CopperReview/wasm/').replace(/\/?$/,'/');
const pinned=readFileSync(join(root,'.copperscript-version'),'utf8').trim(),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function download(name){const response=await fetch(base+name,{cache:'no-store'});if(!response.ok)throw Error(`${base+name}: HTTP ${response.status}`);return Buffer.from(await response.arrayBuffer());}
const manifestBytes=await download('manifest.json'),manifest=JSON.parse(manifestBytes);
if(manifest.schema!=='copper-review-wasm-build/v1')throw Error('Unexpected compiler manifest schema.');
if(manifest.source_revision!==pinned||manifest.source_modified)throw Error(`Published compiler is built from ${manifest.source_revision}${manifest.source_modified?' (modified)':''}, not the pinned ${pinned}. Wait for the Pages deploy to finish, or build locally with npm run build:wasm.`);
const files={'copper_web_bg.wasm':manifest.wasm_sha256,'copper_web.js':manifest.bindings_sha256},bytes={};
for(const [name,expected]of Object.entries(files)){bytes[name]=await download(name);if(sha(bytes[name])!==expected)throw Error(`${name} does not match its build manifest.`);}
// Write into a fresh folder, then swap it in, so a failed download never leaves a mixed set.
const staging=out+'.download';rmSync(staging,{recursive:true,force:true});mkdirSync(staging,{recursive:true});
for(const [name,data]of Object.entries(bytes))writeFileSync(join(staging,name),data);writeFileSync(join(staging,'manifest.json'),manifestBytes);
rmSync(out,{recursive:true,force:true});renameSync(staging,out);
console.log(`Fetched CopperScript WASM ${manifest.wasm_sha256.slice(0,12)} (compiler ${pinned.slice(0,12)}) into ${out}`);
