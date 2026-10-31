import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {projectUrl,discoverProject,downloadDesign,remoteBytes} from '../copper_review/web/projects.js';
import {electricalInput} from '../copper_review/web/compiler.js';
const commit='a'.repeat(40),base='https://api.github.com/repos/owner/board';
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
test('URL parsing supports public repositories, files, refs and explicit slash branches',()=>{
 assert.deepEqual(projectUrl('https://github.com/owner/board.git'),{provider:'github',owner:'owner',repo:'board',ref:'HEAD',path:'',kind:'repository',url:'https://github.com/owner/board'});
 for(const url of ['https://github.com/owner/board/blob/main/board.copper','https://raw.githubusercontent.com/owner/board/main/board.copper']){const p=projectUrl(url);assert.equal(p.kind,'file');assert.equal(p.ref,'main');assert.equal(p.path,'board.copper');}
 const p=projectUrl('https://github.com/owner/board/tree/feature/power/boards/main','feature/power');assert.equal(p.ref,'feature/power');assert.equal(p.path,'boards/main');
 assert.equal(projectUrl('https://example.org/design.json?download=1#fragment').url,'https://example.org/design.json?download=1');
 for(const url of ['javascript:alert(1)','file:///secret.json','http://example.org/board.json','https://user:secret@example.org/board.json','https://github.com/owner/board/issues/1'])assert.throws(()=>projectUrl(url));
 assert.throws(()=>projectUrl('https://github.com/owner/board/blob/main/board.copper','other'),/ref must match/);
});
test('repository discovery pins every candidate to one commit and never silently picks an old export',async()=>{
 const requests=[],fetcher=async(url,options)=>{requests.push([url,options]);return url.includes('/commits/')?json({sha:commit}):json({tree:[
  {path:'board.copper',type:'blob',mode:'100644',size:60},{path:'build/review.ir.json',type:'blob',mode:'100644',size:500},
  {path:'board.scene.json',type:'blob',mode:'100644'},{path:'secret.copper',type:'blob',mode:'120000'},
  {path:'node_modules/noise.copper',type:'blob',mode:'100644'},{path:'copper.lock',type:'blob',mode:'100644'},
  {path:'library',type:'commit',mode:'160000'}]});};
 const result=await discoverProject('https://github.com/owner/board',{fetcher,ref:'release/v1'});
 assert.equal(requests[0][0],`${base}/commits/release%2Fv1`);assert.equal(requests[1][0],`${base}/git/trees/${commit}?recursive=1`);
 assert.equal(result.commit,commit);assert.equal(result.kind,'repository');assert.equal(result.files.length,3);
 for(const f of result.files){assert(f.url.includes(`/${commit}/`));assert.equal(f.origin.commit,commit);assert.equal(f.origin.repository,'https://github.com/owner/board');}
 for(const [,options]of requests){assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.headers,undefined);}
});
test('GitHub file URLs resolve branch once before downloading exact bytes with source provenance',async()=>{
 const bytes=Buffer.from('\ufeff{\r\n"schema":"copperscript-ir/v0.1","kind":"board","name":"Remote"\r\n}'),requests=[];
 const fetcher=async url=>{requests.push(url);return url.includes('/commits/')?json({sha:commit}):new Response(bytes);};
 const project=await discoverProject('https://github.com/owner/board/blob/main/review.ir.json',{fetcher});assert.equal(requests.length,1);
 const file=await downloadDesign(project.files[0],{fetcher}),input=await electricalInput(file.bytes,file.name);
 assert.equal(input.input.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(file.origin.path,'review.ir.json');assert.equal(file.origin.commit,commit);
 assert.equal(requests[1],`https://raw.githubusercontent.com/owner/board/${commit}/review.ir.json`);
});
test('folder discovery excludes sibling targets and raw HTTPS files need no GitHub API',async()=>{
 const project=await discoverProject('https://github.com/owner/board/tree/main/boards/a',{fetcher:async url=>url.includes('/commits/')?json({sha:commit}):json({tree:[{type:'blob',mode:'100644',path:'boards/a/board.copper'},{type:'blob',mode:'100644',path:'boards/ab/board.copper'}]})});
 assert.deepEqual(project.files.map(f=>f.path),['boards/a/board.copper']);
 const direct=await discoverProject('https://example.org/design.json',{fetcher:()=>{throw Error('No discovery request expected');}});assert.equal(direct.files[0].url,'https://example.org/design.json');
});
test('incomplete trees, private projects and rate limits fail explicitly',async()=>{
 await assert.rejects(()=>discoverProject('https://github.com/owner/board',{fetcher:async url=>url.includes('/commits/')?json({sha:commit}):json({tree:[],truncated:true})}),/incomplete/);
 for(const [status,pattern]of [[404,/Private/],[403,/rate limit/],[429,/rate limit/]])await assert.rejects(()=>discoverProject('https://github.com/owner/board',{fetcher:async()=>new Response('',{status})}),pattern);
 await assert.rejects(()=>discoverProject('https://github.com/owner/board',{fetcher:async()=>json({sha:'main'})}),/immutable/);
});
test('downloads enforce streamed bounds, cancellation and readable network failures',async()=>{
 let cancelled=false;await assert.rejects(()=>remoteBytes('https://example.org/large.json',{limit:10,fetcher:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(11));},cancel(){cancelled=true;}}))}),/size limit/);assert(cancelled);
 await assert.rejects(()=>remoteBytes('https://example.org/file',{fetcher:async()=>{throw Error('Network error');}}),/CORS/);
 const controller=new AbortController();controller.abort(Error('Cancelled by user'));await assert.rejects(()=>remoteBytes('https://example.org/file',{signal:controller.signal,fetcher:async(_,options)=>{assert(options.signal.aborted);throw options.signal.reason;}}),/Cancelled/);
});
