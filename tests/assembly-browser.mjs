/* Assembly mode on the demo board: plan without and with a sheet, marking, persistence, export. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE || 'playwright');
const url=process.argv[2];assert(url && new URL(url).hostname==='127.0.0.1');
const browser=await chromium.launch({headless:true,...(process.env.COPPER_BROWSER_EXECUTABLE?{executablePath:process.env.COPPER_BROWSER_EXECUTABLE}:{})});
const page=await browser.newPage({viewport:{width:1520,height:1020}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
mkdirSync('test-results',{recursive:true});
const lines=()=>page.locator('.assembly-line').evaluateAll(rows=>rows.map(r=>({title:r.querySelector('.line-title').textContent,count:r.querySelector('.line-count').textContent,current:r.classList.contains('current'),done:r.classList.contains('done')})));
try {
  await page.goto(url);
  await page.evaluate(()=>localStorage.clear());await page.reload();
  await page.waitForFunction(()=>document.querySelectorAll('.entity').length===4);
  await page.keyboard.press('a');
  await page.waitForFunction(()=>document.body.dataset.mode==='assembly');
  assert(await page.locator('.assembly-list-panel').isVisible());
  assert(!(await page.locator('.explorer').isVisible()),'the review explorer is hidden in assembly mode');
  // From the board alone: SMD first (smallest body leads), through-hole last.
  let plan=await lines();
  assert.deepEqual(plan.map(l=>l.title),['100 nF','Sensor','Controller','Power in'],JSON.stringify(plan));
  assert(plan[0].current);
  assert.match(await page.locator('#assembly-source').textContent(),/board file only/);
  await page.keyboard.press(' ');
  plan=await lines();
  assert(plan[0].done&&plan[1].current,JSON.stringify(plan));
  // Moving on selects the next part to place and zooms in on it.
  await page.waitForFunction(()=>document.querySelector('#assembly-part-title').textContent==='PART U2');
  const zoomOf=async()=>Number((await page.locator('#zoom-status').textContent()).match(/([\d.]+) px\/mm/)[1]);
  const focused=await zoomOf();
  // Back to the finished first line: nothing left to place, so its parts are framed and none selected.
  await page.keyboard.press('k');
  assert(await page.locator('#assembly-part').isHidden(),'no part selected on a finished line');
  await page.waitForFunction(z=>!document.querySelector('#zoom-status').textContent.includes(`${z.toFixed(1)} px/mm`),focused);
  await page.keyboard.press('j');await page.locator('#fit').click();
  assert.match(await page.locator('#assembly-progress-text').textContent(),/^1\/4 placed/);

  // Opening the sheet asks before replacing board-only progress, then matches by CopperScript path.
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('#any-file').setInputFiles('examples/demo.assembly-sheet.json');
  await page.waitForFunction(()=>document.querySelector('#assembly-source').textContent.includes('Sheet: Demo'));
  assert.match(await page.locator('#assembly-progress-text').textContent(),/^0\/4 placed/);
  assert.match(await page.locator('#assembly-current').textContent(),/DP-0402-104K/);
  assert.match(await page.locator('#assembly-current').textContent(),/Pin 1ringed on the board/);
  await page.locator('#assembly-mark').click();
  // Pick U1 on the board itself and flag it.
  await page.locator('#assembly-zoom').click();await page.locator('#fit').click();
  const box=await page.locator('#board-canvas').boundingBox();
  const zoom=Math.min((box.width-80)/50,(box.height-80)/35);
  await page.mouse.click(box.x+box.width/2+(20-25)*zoom,box.y+(box.height-20)/2+(17-17.5)*zoom);
  await page.waitForFunction(()=>document.querySelector('#assembly-part-title').textContent==='PART U1');
  await page.locator('#assembly-problem').check();
  await page.locator('#assembly-note').fill('Pin 3 bridged');
  await page.locator('#assembly-filter').evaluate(s=>{s.value='problems';s.dispatchEvent(new Event('change'));});
  plan=await lines();
  assert.deepEqual(plan.map(l=>l.title),['Controller'],JSON.stringify(plan));
  await page.locator('#assembly-filter').evaluate(s=>{s.value='all';s.dispatchEvent(new Event('change'));});
  await page.screenshot({path:'test-results/assembly.png'});
  // The realistic look is on by default here and toggles with V; the choice is remembered per mode.
  assert.equal(await page.locator('#view-real').getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('v');
  assert.equal(await page.locator('#view-real').getAttribute('aria-pressed'),'false');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('copper-review:realistic')).assembly),false);
  await page.keyboard.press('v');
  // The minimap shows only when zoomed in, and clicking it moves the view.
  assert(await page.locator('#minimap').isHidden(),'no minimap at full-board fit');
  await page.locator('#assembly-zoom').click();
  await page.waitForFunction(()=>!document.querySelector('#minimap').hidden);
  const before=await page.locator('#zoom-status').textContent(),mini=await page.locator('#minimap').boundingBox();
  await page.mouse.click(mini.x+mini.width*.15,mini.y+mini.height*.8);
  assert.equal(await page.locator('#zoom-status').textContent(),before,'the minimap pans without zooming');
  await page.screenshot({path:'test-results/assembly-zoomed.png'});
  // N cycles the parts of the current line (one part here, so it stays on U1).
  await page.keyboard.press('Escape');await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>document.querySelector('#assembly-part-title').textContent==='PART U1');
  await page.locator('#fit').click();

  // Progress survives a reload and exports with the sheet; a different board file is refused.
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.entity').length===4);
  await page.keyboard.press('a');
  await page.waitForFunction(()=>document.querySelector('#assembly-source').textContent.includes('Sheet: Demo'));
  assert.match(await page.locator('#assembly-progress-text').textContent(),/^1\/4 placed .* 1 need rework$/);
  const download=page.waitForEvent('download');await page.locator('#export-menu').click();await page.locator('#export-assembly').click();
  const exported=JSON.parse(readFileSync(await (await download).path(),'utf8'));
  assert.equal(exported.schema,'copper-review-assembly/v1');
  assert.equal(exported.components.U1.note,'Pin 3 bridged');
  assert.equal(exported.sheet.board,'Demo');
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('#assembly-reset').click();
  await page.waitForFunction(()=>document.querySelector('#assembly-progress-text').textContent.startsWith('0/4 placed'));
  await page.locator('#any-file').setInputFiles({name:'progress.assembly.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(exported))});
  await page.waitForFunction(()=>document.querySelector('#assembly-progress-text').textContent.startsWith('1/4 placed'));
  await page.locator('#any-file').setInputFiles({name:'other.assembly.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...exported,board:{...exported.board,sha256:'0'.repeat(64)}}))});
  await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('different board'));
  // The assembly.lock itself opens like the sheet it would write; progress carries over.
  await page.locator('#any-file').setInputFiles('examples/demo.assembly.lock');
  await page.waitForFunction(()=>document.querySelector('#assembly-source').textContent.startsWith('assembly.lock: Demo'));
  assert.match(await page.locator('#assembly-progress-text').textContent(),/^1\/4 placed/);
  const limits=await page.locator('#assembly-warnings').textContent();
  assert.match(limits,/copper assembly check has not run here/);
  assert.match(limits,/1 selection\(s\) not yet reviewed in the lock: sensing\.U2/);
  // The layout review is untouched by assembly progress.
  await page.keyboard.press('l');
  assert(await page.locator('.explorer').isVisible());
  assert.deepEqual(errors,[]);
  console.log('assembly browser test passed');
} finally {await browser.close();}
