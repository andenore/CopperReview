/* Build from an explicit CopperScript checkout; never download a compiler at runtime. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),compiler=resolve(process.env.COPPERSCRIPT_REPO||join(root,'..','CopperScript'));
const run=(cmd,args,capture=false)=>{const r=spawnSync(cmd,args,{cwd:compiler,encoding:'utf8',stdio:capture?'pipe':'inherit',windowsHide:true});if(r.error)throw r.error;if(r.status!==0)throw Error(`${cmd} failed (${r.status}): ${r.stderr||''}`);return r.stdout;};
const bindgen=process.env.WASM_BINDGEN||'wasm-bindgen';
if(run(bindgen,['--version'],true).trim()!=='wasm-bindgen 0.2.130')throw Error('Build requires wasm-bindgen 0.2.130, matching CopperScript.');
run('cargo',['build','--locked','--release','--target','wasm32-unknown-unknown','-p','copper-web']);
const metadata=JSON.parse(run('cargo',['metadata','--locked','--no-deps','--format-version','1'],true));
const out=join(root,'copper_review','web','wasm');mkdirSync(out,{recursive:true});
run(bindgen,[join(metadata.target_directory,'wasm32-unknown-unknown','release','copper_web.wasm'),'--target','web','--out-dir',out,'--out-name','copper_web','--no-typescript']);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');let revision=null,modified=null;
try{revision=run('git',['rev-parse','HEAD'],true).trim();modified=run('git',['diff','--name-only','HEAD','--','crates','Cargo.toml','Cargo.lock'],true).trim().length>0;}catch{}
const manifest={schema:'copper-review-wasm-build/v1',crate:'copper-web',compiler_version:metadata.packages.find(p=>p.name==='copper-web').version,source_revision:revision,source_modified:modified,cargo_lock_sha256:sha(readFileSync(join(compiler,'Cargo.lock'))),wasm_sha256:sha(readFileSync(join(out,'copper_web_bg.wasm'))),bindings_sha256:sha(readFileSync(join(out,'copper_web.js'))),wasm_bindgen:'0.2.130'};
writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(`Built CopperScript WASM: ${manifest.wasm_sha256}`);
