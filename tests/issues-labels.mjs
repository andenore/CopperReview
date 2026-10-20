/* Browser checks for CopperScript issue windows/citations and non-overlapping reference labels. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE || 'playwright');
const url=process.argv[2];assert(url && new URL(url).hostname==='127.0.0.1');
mkdirSync('test-results',{recursive:true});
const sha=createHash('sha256').update(readFileSync(new URL('../examples/demo.kicad_pcb',import.meta.url))).digest('hex');
const issues={schema:'copperscript.run-issues/v1',run:'build/demo/runs/T1',status:'fail',board_sha256:sha,filled_board_sha256:null,omitted:0,
  issues:[{id:'P1',stage:'access',code:'PACKAGE-EXIT-PENDING',title:'2 pads of U1 have no exit',count:2,nets:['SENSOR_SCL'],layers:['F.Cu'],objects:['U1.3'],window_mm:[22,14,25,17],markers:2},
          {id:'N1',stage:'native',code:'NATIVE-UNCONNECTED',title:'GND split',count:1,nets:['GND'],layers:[],objects:[],window_mm:null,markers:0,caused_by:'P1'}]};
writeFileSync('test-results/demo.issues.json',JSON.stringify(issues));
writeFileSync('test-results/other.issues.json',JSON.stringify({...issues,board_sha256:'0'.repeat(64)}));
const browser=await chromium.launch({headless:true,...(process.env.COPPER_BROWSER_EXECUTABLE?{executablePath:process.env.COPPER_BROWSER_EXECUTABLE}:{})});
const page=await browser.newPage({viewport:{width:1520,height:1020}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto(url);await page.waitForFunction(()=>document.querySelectorAll('.entity').length===4);
  assert(await page.locator('#tab-issues').isHidden());
  await page.locator('#issues-file').setInputFiles('test-results/other.issues.json');
  await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('different board revision'));
  assert(await page.locator('#tab-issues').isHidden());
  await page.locator('#issues-file').setInputFiles('test-results/demo.issues.json');
  await page.waitForFunction(()=>!document.querySelector('#tab-issues').hidden);
  assert.equal(await page.locator('#issue-count').textContent(),'2');
  await page.locator('#tab-issues').click();assert.equal(await page.locator('.entity').count(),2);
  await page.locator('.entity').first().click();
  assert.equal(await page.locator('#issue-ids').inputValue(),'P1');
  assert((await page.locator('#selection-detail').textContent()).includes('Region'));
  await page.locator('#observation').fill('P1: C1 blocks the U1 exits.');await page.locator('#category').selectOption('package_escape');
  await page.locator('#save-note').click();assert.equal(await page.locator('.note-row').count(),1);
  await page.locator('#issue-ids').fill('Z9');await page.locator('#observation').fill('Unknown id.');await page.locator('#board-wide').check();
  await page.locator('#save-note').click();
  await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('Z9 is not in the loaded list'));
  assert.equal(await page.locator('.note-row').count(),1);
  const downloadPromise=page.waitForEvent('download');await page.locator('#export-review').click();
  await (await downloadPromise).saveAs('test-results/issues.review.json');
  const review=JSON.parse(readFileSync('test-results/issues.review.json'));
  assert.deepEqual(review.annotations[0].issues,['P1']);assert.equal(review.annotations[0].context.issues[0].code,'PACKAGE-EXIT-PENDING');
  assert.equal(review.copperscript_issues.board_verified,true);assert.equal(review.copperscript_issues.run,'build/demo/runs/T1');
  // Editing the note after a reload (no issue list loaded) keeps its citation.
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.note-row').length===1);
  await page.locator('.note').first().click();assert.equal(await page.locator('#issue-ids').inputValue(),'P1');
  await page.locator('#observation').fill('P1: edited.');await page.locator('#save-note').click();
  assert((await page.locator('.note-title').first().textContent()).includes('edited'));
  // Labels: all four fit at board zoom; zoomed far out they would collide, so only one is drawn.
  await page.locator('#fit').click();await page.waitForTimeout(100);
  const canvas=page.locator('#board-canvas');
  assert.equal(await canvas.getAttribute('data-hidden-labels'),'0');assert.equal(await canvas.getAttribute('data-shown-labels'),'4');
  const box=await canvas.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  for(let i=0;i<12;i++){await page.mouse.wheel(0,400);await page.waitForTimeout(20);}
  await page.waitForTimeout(100);
  const shown=Number(await canvas.getAttribute('data-shown-labels')),hidden=Number(await canvas.getAttribute('data-hidden-labels'));
  assert(shown>=1 && hidden>=1 && shown+hidden===4,`${shown} shown, ${hidden} hidden`);
  assert((await page.locator('#zoom-status').textContent()).includes('labels hidden'));
  await page.screenshot({path:'test-results/issues-labels.png'});
  assert.deepEqual(errors,[]);
  console.log(`PASS: issue list board check, issue tab/window/citation, unknown-id rejection, export, edit after reload; labels ${shown} shown/${hidden} hidden when zoomed out`);
} finally {await browser.close();}
