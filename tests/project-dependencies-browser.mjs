import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {projectFixture} from './project-fixture.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE||'playwright');
const url=process.argv[2];assert.equal(new URL(url).hostname,'127.0.0.1');
const browser=await chromium.launch({headless:true,executablePath:process.env.COPPER_BROWSER_EXECUTABLE||undefined}),page=await browser.newPage({viewport:{width:1450,height:1000}}),errors=[],remote=[],posts=[];
page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).hostname!=='127.0.0.1')remote.push(r.url());if(r.method()==='POST')posts.push(r.url());});
const f=projectFixture(),headers={'Access-Control-Allow-Origin':'*'};let corrupt=false,missingLock=false,delay=false,started;
await page.route('https://api.github.com/repos/url-test/project/**',r=>r.fulfill({headers,contentType:'application/json',body:JSON.stringify(r.request().url().includes('/commits/')?{sha:f.commit}:{tree:f.tree.filter(file=>!missingLock||!file.path.endsWith('copper.lock'))})}));
await page.route(`https://raw.githubusercontent.com/url-test/project/${f.commit}/**`,r=>r.fulfill({headers,body:f.workspace[new URL(r.request().url()).pathname.split(`/${f.commit}/`)[1]]}));
await page.route(`https://raw.githubusercontent.com/url-test/parts/${f.version}/**`,async r=>{
 const path=new URL(r.request().url()).pathname.split(`/${f.version}/`)[1];if(delay&&path==='pkg/unit.copper'){started();await new Promise(resolve=>setTimeout(resolve,500));}
 try{await r.fulfill({headers,body:f.sources[path]+(corrupt?' ':'')});}catch{}
});
const open=async()=>{await page.locator('#open-url').click();await page.locator('#project-url').fill('https://github.com/url-test/project/blob/main/boards/main/board.copper');await page.locator('#project-discover').click();};
try{
 await page.goto(url);await open();await page.waitForFunction(()=>document.getElementById('electrical-name').textContent==='RemoteProject');await page.waitForSelector('#project-dialog:not([open])',{state:'attached'});
 assert.match(await page.locator('#compiler-result-title').textContent(),/CopperScript WASM/);await page.locator('#compiler-result-title').click();assert.match(await page.locator('#compiler-result-content').textContent(),/4 source files.*1 dependency repositories/);
 const identity=await page.locator('#electrical-meta').textContent();await page.locator('#electrical-show-passives').check();assert(await page.locator('#electrical-entities').getByRole('button',{name:'X/Inner/D/R',exact:true}).isVisible());
 mkdirSync('test-results',{recursive:true});const download=page.waitForEvent('download');await page.locator('#electrical-export').click();await(await download).saveAs('test-results/project-dependencies.review.json');const review=JSON.parse(readFileSync('test-results/project-dependencies.review.json'));
 assert.equal(review.input.project.files.length,4);assert.equal(review.input.project.modules[0].commit,f.version);assert.equal(review.input.project.lock.sha256,createHash('sha256').update(f.lock).digest('hex'));assert.match(review.input.project.scope,/physical assets not fetched/);
 await page.reload();await page.waitForFunction(()=>document.getElementById('electrical-name').textContent==='RemoteProject');assert.match(await page.locator('#project-origin').textContent(),/boards\/main\/board.copper/);
 corrupt=true;await open();await page.waitForFunction(()=>document.getElementById('project-status').textContent.includes('checksum mismatch'));assert.equal(await page.locator('#electrical-meta').textContent(),identity);await page.locator('#project-close').click();corrupt=false;
 missingLock=true;await page.reload();await page.waitForFunction(()=>document.getElementById('electrical-name').textContent==='RemoteProject');await open();await page.waitForFunction(()=>document.getElementById('project-status').textContent.includes('PKG010'));assert.equal(await page.locator('#electrical-meta').textContent(),identity);await page.locator('#project-close').click();missingLock=false;
 await page.reload();await page.waitForFunction(()=>document.getElementById('electrical-name').textContent==='RemoteProject');delay=true;const pending=new Promise(resolve=>started=resolve);await open();await pending;await page.locator('#project-cancel').click();assert.match(await page.locator('#project-status').textContent(),/cancelled/);await page.locator('#project-close').click();await page.waitForTimeout(700);assert.equal(await page.locator('#electrical-meta').textContent(),identity);
 await page.screenshot({path:'test-results/project-dependencies.png'});
 assert(remote.filter(u=>u.includes('raw.githubusercontent.com/url-test/parts/')).every(u=>u.includes(`/${f.version}/`)));assert(!remote.some(u=>/\.kicad_mod|\.step/.test(u)));assert.deepEqual(posts,[]);assert.deepEqual(errors,[]);
 console.log('PASS: browser imports local/transitive/relative packages using real WASM, verifies lock bytes, exports/resumes project provenance, rejects tampering/missing pins, cancels safely; no source upload or physical assets');
}catch(error){console.error(await page.locator('#project-status').textContent(),errors);mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/project-dependencies-failure.png'});throw error;}finally{await browser.close();}
