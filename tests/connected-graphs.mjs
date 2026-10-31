import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE||'playwright');
const url=process.argv[2];assert.equal(new URL(url).hostname,'127.0.0.1');
const browser=await chromium.launch({headless:true,executablePath:process.env.COPPER_BROWSER_EXECUTABLE||undefined}),page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(url);await page.locator('#electrical-file').setInputFiles(process.argv[3]||'tests/fixtures/electrical-ir.json');await page.waitForSelector('#electrical-review:not([hidden])');
 mkdirSync('test-results',{recursive:true});
 for(const mode of ['power','bus']){
   await page.locator(`[data-electrical-view="${mode}"]`).click();
   const svg=page.locator('.electrical-connected-graph');assert.equal(await svg.count(),1);
   const paths=()=>svg.locator(mode==='power'?'[data-power-net]':'[data-bus-bundle]').evaluateAll(nodes=>nodes.map(n=>[n.dataset.powerNet||n.dataset.busBundle,n.querySelector('.electrical-graph-wire').getAttribute('d')]).sort());
   const beforePaths=await paths();
   if(mode==='power'){assert.equal(await svg.locator('[data-power-net]').count(),await svg.locator('[data-power-rail]').count());assert.equal(await svg.locator('.electrical-power-underlay').count(),beforePaths.length);}
   else{
     assert.equal(await svg.locator('[data-bus-bundle]').count(),await svg.locator('[data-topology-bus]').count());assert.equal(await svg.locator('.electrical-bus-underlay').count(),beforePaths.length);
     assert(await page.locator('[aria-label="Bus protocol legend"]').isVisible());
     const keys=await svg.locator('[data-topology-bus]').evaluateAll(nodes=>[...new Set(nodes.map(n=>n.dataset.busProtocol))].sort());
     assert.deepEqual(await page.locator('.electrical-bus-key').evaluateAll(nodes=>[...new Set(nodes.map(n=>n.dataset.busProtocol))].sort()),keys);
     for(const [key,label]of [['i2c','I²C'],['uart','UART'],['usb','USB']])if(keys.includes(key))assert(await page.locator('.electrical-bus-key').getByText(label,{exact:true}).isVisible());
     assert(await svg.locator('[data-topology-bus]').evaluateAll(nodes=>nodes.every(n=>n.querySelector('.electrical-net-label').textContent.trim()&&n.querySelector('title').textContent.includes(n.querySelector('.electrical-net-label').textContent.trim().replace(/^…/,'')))));
   }
   const ids=await svg.locator('[data-topology-device]').evaluateAll(nodes=>nodes.map(n=>n.dataset.topologyDevice));assert(ids.length>0);assert.equal(ids.length,new Set(ids).size,`duplicate ${mode} device`);
   if(ids.includes('U_MODEM'))assert.equal(ids.filter(id=>id==='U_MODEM').length,1);
   const device=svg.locator('[data-topology-device]').first();const id=await device.getAttribute('data-topology-device');await device.locator('rect').click();assert.equal(await page.locator('#electrical-inspector h3').textContent(),id);
   assert.deepEqual(await paths(),beforePaths,`selection must not move ${mode} paths`);
   const hub=page.locator('.electrical-connected-graph [data-topology-node]').filter({has:page.locator('.electrical-net-label')}).first();const selected=await hub.getAttribute('data-entity');await hub.locator('.electrical-net-label').click();assert.equal(await page.locator('#electrical-inspector h3').textContent(),selected);
   if(mode==='bus')assert((await page.locator('#electrical-intent').textContent()).includes(selected.split(':').slice(1).join(':')),'bus selection must update intent');
   await page.locator('#electrical-fit').click();assert(await page.locator('#electrical-canvas').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
   if(mode==='power'){const fitted=await svg.evaluate(e=>e.style.width);await page.locator('[data-electrical-view="bus"]').click();assert(await page.locator('.electrical-connected-graph').evaluate(e=>parseFloat(e.style.width)===Number(e.dataset.naturalWidth)));await page.locator('[data-electrical-view="power"]').click();assert.equal(await svg.evaluate(e=>e.style.width),fitted);}
   await page.screenshot({path:`test-results/connected-${mode}.png`});
   if(mode==='bus'){await page.locator('#electrical-show-passives').check();assert(await svg.locator('[data-topology-device]').count()>=ids.length);await page.locator('#electrical-show-passives').uncheck();assert.deepEqual(await paths(),beforePaths);}
   await page.locator('#electrical-actual-size').click();
   await page.locator(`#electrical-${mode}-connections`).click();assert.equal(await page.locator('.electrical-connected-graph').count(),0);
   await page.locator(`#electrical-${mode}-topology`).click();assert.equal(await page.locator('.electrical-connected-graph').count(),1);
 }
 await page.setViewportSize({width:390,height:850});for(const mode of ['power','bus']){await page.locator(`[data-electrical-view="${mode}"]`).click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 assert.deepEqual(errors,[]);console.log('PASS: stable connected figures, unique devices, logical bus names/protocol legend, separate bundles, linked inspector, details, independent zoom and responsive scrolling');
}finally{await browser.close();}
