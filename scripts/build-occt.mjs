/* Fetch the STEP reader (occt-import-js: OpenCascade compiled to WASM, LGPL-2.1) that draws KiCad's STEP models.
   It is pinned by npm's integrity hash, never committed, and loaded only when a STEP model is shown. */
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const VERSION='0.0.23';
const INTEGRITY='sha512-RFfYQXYFX5C1mB1Aywm0ShcUKzXOr/VzTnlzhBSDJOR6YCAPt1HYCzeXWg1vwwjn/cUxwqRNhhtf1dlewoZYCQ==';
const URL_=`https://registry.npmjs.org/occt-import-js/-/occt-import-js-${VERSION}.tgz`;
const FILES=['occt-import-js.js','occt-import-js.wasm','license.occt-import-js.txt','license.occt.txt'];
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=join(root,'copper_review','web','occt');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function current() {
  try{
    const manifest=JSON.parse(readFileSync(join(out,'manifest.json'),'utf8'));
    if(manifest.version!==VERSION||manifest.integrity!==INTEGRITY)return null;
    for(const file of FILES)if(!existsSync(join(out,file)))return null;
    if(sha256(readFileSync(join(out,'occt-import-js.wasm')))!==manifest.wasm_sha256)return null;
    if(sha256(readFileSync(join(out,'occt-import-js.js')))!==manifest.js_sha256)return null;
    return manifest;
  }catch{return null;}
}

if(current()){console.log(`STEP reader already built: occt-import-js ${VERSION}`);process.exit(0);}
const response=await fetch(URL_);
if(!response.ok)throw Error(`Could not download occt-import-js ${VERSION}: HTTP ${response.status}`);
const archive=Buffer.from(await response.arrayBuffer());
if(`sha512-${createHash('sha512').update(archive).digest('base64')}`!==INTEGRITY)throw Error('occt-import-js does not match its pinned integrity hash.');
const work=mkdtempSync(join(tmpdir(),'copper-review-occt-'));
try{
  writeFileSync(join(work,'occt.tgz'),archive);
  const unpacked=spawnSync('tar',['-xzf','occt.tgz'],{cwd:work,encoding:'utf8',windowsHide:true});
  if(unpacked.status!==0)throw Error(`tar failed: ${unpacked.stderr||unpacked.error}`);
  mkdirSync(out,{recursive:true});
  for(const file of FILES)copyFileSync(join(work,'package','dist',file),join(out,file));
  const manifest={schema:'copper-review-occt-build/v1',package:'occt-import-js',version:VERSION,integrity:INTEGRITY,license:'LGPL-2.1 (see license.*.txt)',
    js_sha256:sha256(readFileSync(join(out,'occt-import-js.js'))),wasm_sha256:sha256(readFileSync(join(out,'occt-import-js.wasm')))};
  writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(`Built STEP reader: occt-import-js ${VERSION} (${(archive.length/1e6).toFixed(1)} MB download)`);
}finally{rmSync(work,{recursive:true,force:true});}
