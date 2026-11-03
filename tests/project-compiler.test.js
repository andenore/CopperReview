import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareGithubProject,prepareLocalProject,localBoardSources} from '../copper_review/web/project-compiler.js';
import {projectFixture} from './project-fixture.js';
const json=value=>new Response(JSON.stringify(value));
function transport(fixture,requests=[]){return async(url,options)=>{
  requests.push(url);assert.equal(options.credentials,'omit');assert(!options.headers);
  if(url.startsWith('https://api.github.com/repos/url-test/project/git/trees/'))return json({tree:fixture.tree});
  const parsed=new URL(url),prefix=`/url-test/project/${fixture.commit}/`;
  if(parsed.pathname.startsWith(prefix))return new Response(fixture.workspace[parsed.pathname.slice(prefix.length)]);
  const lib=`/url-test/parts/${fixture.version}/`;if(parsed.pathname.startsWith(lib))return new Response(fixture.sources[parsed.pathname.slice(lib.length)]);
  throw Error('Unexpected request '+url);
};}
test('browser transport finds nearest manifest, preserves lock bytes and fetches pinned sources only',async()=>{
 const f=projectFixture(),requests=[],prepared=await prepareGithubProject({origin:f.origin},Buffer.from(f.entry),{fetcher:transport(f,requests)});
 assert.equal(prepared.snapshot.entry,'board.copper');assert.equal(prepared.snapshot.manifest,f.manifest);assert.equal(prepared.snapshot.lock,f.lock);
 assert.deepEqual(prepared.snapshot.workspace_files.sort(),['board.copper','src/wrapper.copper']);
 await prepared.resolveSources(f.requests);assert.equal(Object.keys(prepared.snapshot.files).length,4);assert.equal(prepared.snapshot.files[`dependency/${f.module}/pkg/unit.copper`],f.sources['pkg/unit.copper']);
 assert.equal(prepared.identity.lock.sha256,createHash('sha256').update(f.lock).digest('hex'));assert.equal(prepared.identity.modules[0].commit,f.version);
 assert(requests.filter(u=>u.includes('raw.githubusercontent.com/url-test/parts/')).every(u=>u.includes('/'+f.version+'/')));assert(!requests.some(u=>/footprint|\.step|\.kicad_mod/.test(u)));
});
test('altered dependency bytes and source symlinks cannot enter a project snapshot',async()=>{
 const f=projectFixture(),base=transport(f),fetcher=async(url,options)=>url.endsWith('/pkg/unit.copper')?new Response('tampered'):base(url,options);
 const prepared=await prepareGithubProject({origin:f.origin},Buffer.from(f.entry),{fetcher});await assert.rejects(()=>prepared.resolveSources([f.requests[1]]),/checksum mismatch/);
 const symlink=projectFixture();symlink.tree.push({path:'boards/main/src/other.copper',mode:'120000',type:'blob'});await assert.rejects(()=>prepareGithubProject({origin:symlink.origin},Buffer.from(symlink.entry),{fetcher:transport(symlink)}),/symlinks/);
});
test('dependency downloads are bounded and abort with their compilation',async()=>{
 const f=projectFixture(),prepared=await prepareGithubProject({origin:f.origin},Buffer.from(f.entry),{fetcher:transport(f)});
 await assert.rejects(()=>prepared.resolveSources([{...f.requests[1],size:524289}]),/512 KiB/);
 const second=await prepareGithubProject({origin:f.origin},Buffer.from(f.entry),{fetcher:transport(f)}),controller=new AbortController();controller.abort(Error('Cancelled compilation'));
 await assert.rejects(()=>second.resolveSources([f.requests[0]],{signal:controller.signal}),/Cancelled/);
 await assert.rejects(()=>second.resolveSources([{id:'outside',path:'../outside.copper'}]),/invalid/);
});
test('tag requirements resolve once to an immutable commit for all source requests',async()=>{
 const f=projectFixture(),base=transport(f),requests=[],resolved='c'.repeat(40);
 const fetcher=async(url,options)=>{requests.push(url);if(url==='https://api.github.com/repos/url-test/parts/commits/v1.0')return json({sha:resolved});return base(url.replace(`/parts/${resolved}/`,`/parts/${f.version}/`),options);};
 const prepared=await prepareGithubProject({origin:f.origin},Buffer.from(f.entry),{fetcher});
 await prepared.resolveSources(f.requests.slice(1).map(r=>({...r,revision:'v1.0',version:'v1.0'})));
 assert.equal(requests.filter(u=>u.includes('/parts/commits/')).length,1);assert(requests.filter(u=>u.includes('raw.githubusercontent.com/url-test/parts/')).every(u=>u.includes('/'+resolved+'/')));
 assert.equal(prepared.identity.modules[0].revision,'v1.0');assert.equal(prepared.identity.modules[0].commit,resolved);
});
const folder=f=>new Map(Object.entries(f.workspace).map(([path,text])=>[path,new Blob([text])]));
test('a local folder compiles from its own files and fetches only pinned dependencies',async()=>{
 const f=projectFixture(),requests=[],files=folder(f);files.set('notes/sketch.copper',new Blob(['module Sketch {}']));
 assert.deepEqual(await localBoardSources(files),['boards/main/board.copper']);
 const prepared=await prepareLocalProject(files,'boards/main/board.copper',Buffer.from(f.entry),{fetcher:transport(f,requests)});
 assert.equal(prepared.snapshot.entry,'board.copper');assert.equal(prepared.snapshot.lock,f.lock);assert.deepEqual(prepared.snapshot.workspace_files.sort(),['board.copper','src/wrapper.copper']);
 await prepared.resolveSources(f.requests);assert.equal(prepared.snapshot.files['workspace/src/wrapper.copper'],f.workspace['boards/main/src/wrapper.copper']);
 assert(requests.length&&requests.every(u=>u.includes('/url-test/parts/')),'only dependency requests leave the machine');
 assert.equal(prepared.identity.lock.sha256,createHash('sha256').update(f.lock).digest('hex'));
});
test('a local folder rejects tampered dependencies, missing entries and paths outside the folder',async()=>{
 const f=projectFixture(),base=transport(f),fetcher=async(url,options)=>url.endsWith('/pkg/unit.copper')?new Response('tampered'):base(url,options);
 const prepared=await prepareLocalProject(folder(f),'boards/main/board.copper',Buffer.from(f.entry),{fetcher});
 await assert.rejects(()=>prepared.resolveSources([f.requests[1]]),/checksum mismatch/);
 await assert.rejects(()=>prepared.resolveSources([{id:'outside',path:'../outside.copper'}]),/invalid/);
 await assert.rejects(()=>prepareLocalProject(folder(f),'boards/other/board.copper',Buffer.from(f.entry),{fetcher}),/absent from the chosen folder/);
 await assert.rejects(()=>prepareLocalProject(folder(f),'../board.copper',Buffer.from(f.entry),{fetcher}),/inside the folder/);
});
