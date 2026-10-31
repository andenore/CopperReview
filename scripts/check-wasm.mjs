import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import init,{review,analyze,review_project} from '../copper_review/web/wasm/copper_web.js';
import {electricalModel} from '../copper_review/web/electrical-model.js';
const bytes=readFileSync(new URL('../copper_review/web/wasm/copper_web_bg.wasm',import.meta.url)),manifest=JSON.parse(readFileSync(new URL('../copper_review/web/wasm/manifest.json',import.meta.url)));
assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.wasm_sha256);
await init({module_or_path:bytes});
const source=readFileSync(new URL('../copper_review/web/example.copper',import.meta.url),'utf8'),check=s=>JSON.parse(review(s));
const good=check(source);assert.equal(good.schema,'copperscript.review-analysis/v1');assert(good.check.passed);const ir=JSON.parse(good.electrical_ir);assert.equal(ir.schema,'copperscript-ir/v0.1');assert.equal(electricalModel(ir).name,'SensorPlayground');assert(good.nets.length&&good.pins.length);
const playground=JSON.parse(analyze(source));assert.equal(playground.schema,'copperscript.playground/v1');for(const key of ['check','components','nets','pins'])assert.deepEqual(good[key],playground[key]);
assert.equal(ir.components.find(c=>c.ref==='C1').value.value,'100');assert.equal(ir.components.find(c=>c.ref==='C1').value.unit,'nF');
const voltage=check(source.replace('voltage = 3.3 V;','voltage = 5 V;'));assert(!voltage.check.passed);assert(voltage.electrical_ir);assert(voltage.check.diagnostics.some(d=>d.code.includes('VOLTAGE')));
for(const invalid of ['board {',source.replace('use library','import x "https://example.invalid/parts";\n use library'),' '.repeat(32769)]){const result=check(invalid);assert.equal(result.electrical_ir,null);assert(!result.check.passed);}
assert.deepEqual(check(source.replace(/\r?\n/g,'\r\n')),good);assert.deepEqual(check(source),good);
console.log('PASS: actual CopperScript WASM, CLI IR schema/quantities, native ERC, pin/net queries, import/size errors and recovery');

const {prepareGithubProject}=await import('../copper_review/web/project-compiler.js');
const {projectFixture}=await import('../tests/project-fixture.js');const fixture=projectFixture();
const prepared=await prepareGithubProject({origin:fixture.origin},Buffer.from(fixture.entry),{fetcher:async url=>{
 if(url.includes('/git/trees/'))return new Response(JSON.stringify({tree:fixture.tree}));
 const path=new URL(url).pathname,workspace=`/url-test/project/${fixture.commit}/`,dependency=`/url-test/parts/${fixture.version}/`;
 return new Response(path.startsWith(workspace)?fixture.workspace[path.slice(workspace.length)]:fixture.sources[path.slice(dependency.length)]);
}});
let resolved;for(let wave=0;wave<8;wave++){
 const result=JSON.parse(review_project(JSON.stringify(prepared.snapshot)));
 if(result.schema==='copperscript.project-plan/v1')await prepared.resolveSources(result.requests);
 else{resolved=result;break;}
}
assert(resolved?.electrical_ir,JSON.stringify(resolved));const project=electricalModel(JSON.parse(resolved.electrical_ir));assert.equal(project.name,'RemoteProject');assert(project.components.has('X/Inner/D/R'));assert.equal(resolved.source_snapshot.files.length,4);
prepared.snapshot.files['dependency/github.com/url-test/parts/pkg/unit.copper']+=' ';
const changed=JSON.parse(review_project(JSON.stringify(prepared.snapshot)));assert.equal(changed.electrical_ir,null);assert(changed.check.diagnostics.some(d=>d.message.includes('checksum mismatch')));
console.log('PASS: actual WASM project import planning, transitive local/remote/relative packages, locked source bytes and tamper rejection');
