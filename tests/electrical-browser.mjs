/* Start CopperReview first, then node tests/electrical-browser.mjs URL [IR.json]. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE||'playwright');
const url=process.argv[2];assert.equal(new URL(url).hostname,'127.0.0.1');
const browser=await chromium.launch({headless:true,executablePath:process.env.COPPER_BROWSER_EXECUTABLE||undefined});
const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));mkdirSync('test-results',{recursive:true});
try{
  await page.goto(url);
  await page.locator('#electrical-file').setInputFiles('tests/fixtures/electrical-ir.json');
  await page.waitForFunction(()=>document.getElementById('electrical-name').textContent==='Fixture');
  await page.locator('#electrical-canvas [data-entity="DATA"]').first().click();
  const selected=await page.locator('#electrical-inspector h3').textContent();assert.equal(selected,'DATA');
  for(const view of ['power','bus','focus']){await page.locator(`[data-electrical-view="${view}"]`).click();assert.equal(await page.locator('#electrical-inspector h3').textContent(),selected);}
  await page.locator('[data-electrical-view="power"]').click();await page.locator('#electrical-power-connections').click();await page.locator('#electrical-state').selectOption('OFF');
  assert.match(await page.locator('[data-rail="RAIL"]').textContent(),/Declared off/);
  assert.match(await page.locator('[data-rail="BACKUP"]').textContent(),/State unspecified/);
  await page.locator('#electrical-canvas [data-kind="pin"][data-entity="P/U.OUT"]').click();
  assert.equal(await page.locator('#electrical-inspector h3').textContent(),'P/U.OUT');
  await page.getByRole('button',{name:'Notes',exact:true}).click();
  await page.locator('#electrical-observation').fill('<script>window.injected=true</script> Review shutdown.');
  await page.locator('#electrical-save-note').click();assert.equal(await page.locator('.electrical-note').count(),1);
  const dl=page.waitForEvent('download');await page.locator('#electrical-export').click();await (await dl).saveAs('test-results/electrical.review.json');
  const review=JSON.parse(readFileSync('test-results/electrical.review.json'));assert.equal(review.annotations[0].selection.id,'P/U.OUT');assert.equal(review.schema,'copper-electrical-review/v1');
  await page.reload();await page.waitForSelector('#electrical-review:not([hidden])');
  assert.equal(await page.locator('#electrical-inspector h3').textContent(),'P/U.OUT');
  await page.getByRole('button',{name:'Notes',exact:true}).click();assert.equal(await page.locator('.electrical-note').count(),1);
  assert.equal(await page.evaluate(()=>window.injected),undefined);
  await page.locator('#electrical-review-file').setInputFiles('test-results/electrical.review.json');
  assert.equal(await page.locator('.electrical-note').count(),1);
  // A second IR revision must not inherit notes or accept the previous review.
  const changed=JSON.parse(readFileSync('tests/fixtures/electrical-ir.json'));changed.name='Other revision';
  await page.locator('#electrical-file').setInputFiles({name:'other.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(changed))});
  await page.waitForFunction(()=>document.getElementById('electrical-name').textContent==='Other revision');
  await page.locator('#electrical-review-file').setInputFiles('test-results/electrical.review.json');
  await page.waitForFunction(()=>document.getElementById('message').textContent.includes('does not match'));
  // PCB mode continues to load and select physical entities.
  await page.locator('#board-file').setInputFiles('examples/demo.kicad_pcb');
  await page.waitForSelector('#pcb-review:not([hidden])');assert.equal(await page.locator('.entity').count(),4);
  await page.locator('#show-electrical').click();assert.equal(await page.locator('#electrical-name').textContent(),'Other revision');
  if(process.argv[3]){await page.locator('#electrical-file').setInputFiles(process.argv[3]);await page.waitForFunction(()=>document.getElementById('electrical-name').textContent!=='Other revision');}
  for(const view of ['focus','power','bus']){await page.locator(`[data-electrical-view="${view}"]`).click();await page.screenshot({path:`test-results/electrical-${view}.png`,fullPage:true});}
  await page.setViewportSize({width:390,height:900});
  for(const view of ['focus','power','bus']){await page.locator(`[data-electrical-view="${view}"]`).click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow in ${view}`);}
  assert.deepEqual(errors,[]);console.log('PASS: three linked views, pins, states, notes/export/import, input identity, XSS, PCB coexistence, mobile layout');
}finally{await browser.close();}
