/* Run against a local CopperReview server; optional final argument loads a real IR. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync} from 'node:fs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE||'playwright');
const url=process.argv[2];assert.equal(new URL(url).hostname,'127.0.0.1');
const browser=await chromium.launch({headless:true,executablePath:process.env.COPPER_BROWSER_EXECUTABLE||undefined});
const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
const fixture=JSON.parse(readFileSync('tests/fixtures/electrical-ir.json'));fixture.name='Usability';
fixture.parts.push({name:'cap',category:'passive.capacitor',pins:[{name:'1',number:'1'},{name:'2',number:'2'}]},
 {name:'resistor',category:'passive.resistor',pins:[{name:'1',number:'1'},{name:'2',number:'2'}]});
fixture.components.push({ref:'R_SIGNAL',part:'resistor',properties:{}},{ref:'MON',part:'load',properties:{}});
fixture.nets[0].endpoints=['HOST.TX','R_SIGNAL.1','MON.RX'];fixture.nets.push({name:'DATA2',endpoints:['R_SIGNAL.2','LOAD.RX']},{name:'GROUND',endpoints:[]});
for(let i=0;i<30;i++){
 fixture.components.push({ref:`CAP${i}`,part:'cap',properties:{role:'decoupling',decouples:'LOAD.VDD'}},{ref:`IC${i}`,part:'load',properties:{}});
 fixture.nets.find(n=>n.name==='RAIL').endpoints.push(`CAP${i}.1`,`IC${i}.VDD`);fixture.nets.find(n=>n.name==='GROUND').endpoints.push(`CAP${i}.2`);
}
try{
 await page.goto(url);await page.locator('#any-file').setInputFiles({name:'usability.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
 await page.waitForFunction(()=>document.getElementById('board-name').textContent==='Usability');
 // The explorer selects in place; the Selection sheet draws one hop around it and Back returns.
 await page.locator('#electrical-entities [data-entity="LOAD"]').click();assert.equal(await page.locator('#electrical-inspector h3').textContent(),'LOAD');
 await page.getByRole('button',{name:'Show selection sheet'}).click();assert.equal(await page.locator('#electrical-sheet').inputValue(),'selection');
 assert.equal(await page.locator('.electrical-sch [data-kind="component"][data-entity="R_SIGNAL"]').count(),1);
 await page.locator('#electrical-back').click();assert.notEqual(await page.locator('#electrical-sheet').inputValue(),'selection');assert.equal(await page.locator('#electrical-inspector h3').textContent(),'LOAD');
 // A legible schematic has genuine horizontal scrolling, and Fit can reduce it.
 assert(await page.locator('#electrical-canvas').evaluate(c=>c.scrollWidth>c.clientWidth));
 await page.locator('#electrical-canvas').evaluate(c=>c.scrollLeft=100);assert(await page.locator('#electrical-canvas').evaluate(c=>c.scrollLeft>0));
 await page.locator('#electrical-fit').click();assert(await page.locator('#electrical-canvas').evaluate(c=>c.scrollWidth<=c.clientWidth+1));
 await page.locator('#electrical-actual-size').click();assert(await page.locator('#electrical-canvas').evaluate(c=>c.scrollWidth>c.clientWidth));
 // Power view keeps ICs visible and folds thirty bypass capacitors into one disclosure.
 await page.locator('[data-electrical-view="power"]').click();
 await page.locator('#electrical-power-connections').click();
 const rail=page.locator('[data-rail="RAIL"]');assert(await rail.getByText('30 passive loads',{exact:true}).isVisible());
 assert.equal(await rail.locator('.electrical-load [data-entity="CAP0"]').isVisible(),false);
 assert(await rail.locator('.electrical-load [data-entity="LOAD"]').isVisible());
 await rail.getByText('30 passive loads',{exact:true}).click();assert(await rail.locator('[data-entity="CAP0"]').isVisible());
 assert(await page.locator('#electrical-canvas').evaluate(c=>c.scrollHeight>c.clientHeight));
 await page.locator('#electrical-canvas').evaluate(c=>c.scrollTop=c.scrollHeight);assert(await page.locator('#electrical-canvas').evaluate(c=>c.scrollTop>0));
 // Global override and saved settings keep full electrical membership available.
 await page.locator('#electrical-show-passives').check();assert.equal(await page.locator('[data-rail="RAIL"] summary').filter({hasText:'passive loads'}).count(),0);
 await page.reload();await page.waitForSelector('#electrical-review:not([hidden])');assert(await page.locator('#electrical-show-passives').isChecked());
 await page.locator('#electrical-power-connections').click();
 await page.locator('#electrical-show-passives').uncheck();
 // The Go to picker includes interfaces and rails and selects in place.
 await page.locator('#electrical-focus').selectOption(JSON.stringify({kind:'net',id:'RAIL'}));assert.equal(await page.locator('#electrical-inspector h3').textContent(),'RAIL');
 assert.equal(await page.locator('[data-rail="RAIL"] summary').filter({hasText:'passive loads'}).count(),1);
 await page.locator('#electrical-search').fill('CAP0');await page.locator('#electrical-entities [data-entity="CAP0"]').click();assert.equal(await page.locator('#electrical-inspector h3').textContent(),'CAP0');
 await page.locator('#electrical-search').fill('');await page.locator('[data-electrical-view="bus"]').click();await page.locator('#electrical-bus-connections').click();assert(await page.locator('.electrical-other-signals').isVisible());
 await page.locator('.electrical-bus [data-entity="peripheral:LINK"]').click();assert.equal(await page.locator('[data-electrical-view="schematic"]').getAttribute('aria-selected'),'true');assert.equal(await page.locator('#electrical-sheet').inputValue(),'selection');
 if(process.argv[3]){await page.locator('#any-file').setInputFiles(process.argv[3]);await page.waitForFunction(()=>document.getElementById('board-name').textContent!=='Usability');}
 mkdirSync('test-results',{recursive:true});
 for(const view of ['schematic','power','bus']){await page.locator(`[data-electrical-view="${view}"]`).click();await page.screenshot({path:`test-results/usability-${view}.png`});}
 for(const width of [900,390]){await page.setViewportSize({width,height:800});for(const view of ['schematic','power','bus']){await page.locator(`[data-electrical-view="${view}"]`).click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`document overflow ${width}/${view}`);}}
 assert.deepEqual(errors,[]);console.log('PASS: passive disclosure, signal-path preservation, one-click focus/back, direct circuit picker, two-axis scrolling, fit/100%, saved settings and responsive layout');
}finally{await browser.close();}
