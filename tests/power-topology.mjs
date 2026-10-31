import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync} from 'node:fs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE||'playwright');
const url=process.argv[2];assert.equal(new URL(url).hostname,'127.0.0.1');
const browser=await chromium.launch({headless:true,executablePath:process.env.COPPER_BROWSER_EXECUTABLE||undefined}),page=await browser.newPage({viewport:{width:1400,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(url);await page.locator('#electrical-file').setInputFiles('tests/fixtures/electrical-ir.json');await page.waitForFunction(()=>document.getElementById('electrical-name').textContent==='Fixture');
 await page.locator('[data-electrical-view="power"]').click();
 assert(await page.locator('.electrical-power-topology').isVisible());
 const rail=page.locator('[data-power-rail="RAIL"]');assert.equal(await page.locator('[data-topology-device="P/U"]').count(),1);assert.equal(await page.locator('[data-topology-device="LOAD"]').count(),1);
 assert.equal(await page.locator('.electrical-power-wire').first().evaluate(e=>getComputedStyle(e).stroke),'rgb(240, 117, 117)');
 await page.locator('[data-topology-device="LOAD"]').click();assert.equal(await page.locator('#electrical-inspector h3').textContent(),'LOAD');
 await rail.locator('.electrical-net-label').click();assert.equal(await page.locator('#electrical-inspector h3').textContent(),'RAIL');
 await page.locator('#electrical-state').selectOption('OFF');assert.match(await page.locator('[data-power-rail="RAIL"]').textContent(),/Declared off/);assert.doesNotMatch(await page.locator('[data-power-rail="BACKUP"]').textContent(),/Declared off/);
 await page.locator('#electrical-power-connections').click();assert(await page.locator('[data-rail="RAIL"]').isVisible());
 await page.locator('#electrical-power-topology').click();assert(await page.locator('.electrical-power-topology').isVisible());
 if(process.argv[3]){await page.locator('#electrical-file').setInputFiles(process.argv[3]);await page.waitForFunction(()=>document.getElementById('electrical-name').textContent!=='Fixture');await page.locator('[data-electrical-view="power"]').click();}
 mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/power-topology.png'});
 const pane=page.locator('#electrical-canvas');assert(await pane.evaluate(e=>e.scrollHeight>e.clientHeight));await pane.evaluate(e=>e.scrollTop=e.scrollHeight);assert(await pane.evaluate(e=>e.scrollTop>0));
 await page.locator('#electrical-fit').click();assert(await pane.evaluate(e=>e.scrollWidth<=e.clientWidth+1));await page.locator('#electrical-actual-size').click();
 await page.setViewportSize({width:390,height:850});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);console.log('PASS: red supply topology, source/load boxes, linked inspector, independent states, detailed fallback, Fit and scrolling');
}finally{await browser.close();}
