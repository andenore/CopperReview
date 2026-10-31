import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE||'playwright');
const url=process.argv[2];assert.equal(new URL(url).hostname,'127.0.0.1');assert(new URL(url).pathname.startsWith('/CopperReview/'));
const browser=await chromium.launch({headless:true,executablePath:process.env.COPPER_BROWSER_EXECUTABLE||undefined}),page=await browser.newPage({viewport:{width:1450,height:1000}}),errors=[],api=[],posts=[];
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname.includes('/api/'))api.push(r.url());if(r.method()==='POST')posts.push(r.url());});
const original=readFileSync('copper_review/web/example.copper','utf8');
page.setDefaultTimeout(12000);
const upload=source=>page.locator('#source-file').setInputFiles({name:'local.copper',mimeType:'text/plain',buffer:Buffer.from(source)});
try{
 await page.goto(url);await page.locator('#compiler-example').click();await page.waitForFunction(()=>document.getElementById('electrical-name').textContent==='SensorPlayground');assert.match(await page.locator('#compiler-result-title').textContent(),/ERC passed/);
 await upload(original.replace('voltage = 3.3 V;','voltage = 5 V;'));await page.waitForFunction(()=>document.getElementById('compiler-result-title').textContent.includes('ERC findings'));await page.locator('#compiler-result-title').click();assert.match(await page.locator('#compiler-result-content').textContent(),/VOLTAGE/);
 const identity=await page.locator('#electrical-meta').textContent();await upload(original.replace('use library','import x "https://example.invalid/parts";\n use library'));await page.waitForFunction(()=>document.getElementById('message').textContent.includes('WEB_IMPORT'));assert.equal(await page.locator('#electrical-meta').textContent(),identity);
 await page.route('**/wasm/copper_web_bg.wasm',r=>r.abort());await upload(original);await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Could not load CopperScript'));assert.equal(await page.locator('#electrical-meta').textContent(),identity);await page.unroute('**/wasm/copper_web_bg.wasm');
 await upload(original);await page.waitForFunction(()=>document.getElementById('compiler-result-title').textContent.includes('ERC passed'));
 let started;const loading=new Promise(resolve=>started=resolve);await page.route('**/wasm/copper_web_bg.wasm',async route=>{started();await new Promise(resolve=>setTimeout(resolve,700));try{await route.continue();}catch{}});await upload(original);await loading;await page.locator('#compiler-cancel').click();
 await page.locator('#electrical-file').setInputFiles('tests/fixtures/electrical-ir.json');await page.waitForFunction(()=>document.getElementById('electrical-name').textContent==='Fixture');await page.waitForTimeout(900);assert.equal(await page.locator('#electrical-name').textContent(),'Fixture');await page.unroute('**/wasm/copper_web_bg.wasm');assert(await page.locator('#compiler-result').isHidden());assert.match(await page.locator('#electrical-disclaimer').textContent(),/no simulation or ERC run/);
 await page.getByRole('button',{name:'Notes',exact:true}).click();await page.locator('#electrical-observation').fill('Static review note');await page.locator('#electrical-save-note').click();
 await page.reload();await page.waitForFunction(()=>document.getElementById('electrical-name').textContent==='Fixture');await page.getByRole('button',{name:'Notes',exact:true}).click();assert.equal(await page.locator('.electrical-note').count(),1);
 await page.locator('#board-file').setInputFiles('examples/demo.kicad_pcb');await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Raw KiCad'));assert.equal(await page.locator('#electrical-name').textContent(),'Fixture');
 await page.locator('#board-file').setInputFiles('examples/demo.scene.json');await page.waitForSelector('#pcb-review:not([hidden])');assert.equal(await page.locator('.entity').count(),4);
 await page.locator('#show-electrical').click();assert.equal(await page.locator('#electrical-name').textContent(),'Fixture');
 await upload(original);await page.waitForFunction(()=>document.getElementById('electrical-name').textContent==='SensorPlayground');mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/static-wasm-review.png'});assert.match(await page.locator('#electrical-disclaimer').textContent(),/compiler ERC passed/);
 const download=page.waitForEvent('download');await page.locator('#electrical-export').click();await(await download).saveAs('test-results/wasm-source.review.json');const review=JSON.parse(readFileSync('test-results/wasm-source.review.json'));assert.equal(review.input.source.sha256,createHash('sha256').update(original).digest('hex'));assert.equal(review.input.compiler.wasm_bindgen,'0.2.130');assert.match(review.input.compiler.wasm_sha256,/^[0-9a-f]{64}$/);
 assert.deepEqual(api,[]);assert.deepEqual(posts,[]);assert.deepEqual(errors,[]);
 console.log('PASS: static project subpath, real WASM worker, source compilation/native ERC, imports rejected without upload, load failure/recovery, local IR/scenes, notes and design persistence; zero backend API or POST requests');
}catch(error){console.error('Static UI state:',await page.locator('#message').textContent(),errors);mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/static-failure.png'});throw error;}finally{await browser.close();}
