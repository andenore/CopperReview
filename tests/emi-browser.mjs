/* EMI screening layer in a real browser. Run with an available Playwright installation (not a runtime dependency).
 * Start the server on the example run first:
 *   python -m copper_review examples/emi-buck.kicad_pcb --stage fully_routed \
 *     --route-report examples/emi-buck.route-report.json --no-browser --port 8769
 * then: node tests/emi-browser.mjs "http://127.0.0.1:8769/#token=TOKEN"
 * The old-schema check opens tests/fixtures/emi-old-schema.route-report.json through the file picker. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE || 'playwright');
const url=process.argv[2];assert(url && new URL(url).hostname==='127.0.0.1');
const browser=await chromium.launch({headless:true,...(process.env.COPPER_BROWSER_EXECUTABLE?{executablePath:process.env.COPPER_BROWSER_EXECUTABLE}:{})});
const page=await browser.newPage({viewport:{width:1600,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
mkdirSync('test-results',{recursive:true});
const pressed=()=>page.locator('.emi-item[aria-pressed=true]').getAttribute('data-id');
try {
  await page.goto(url);
  // The server hands the report over with the board: five findings, the hot loop selected, the screening line shown.
  await page.waitForFunction(()=>document.querySelectorAll('.emi-item').length===5);
  assert.match(await page.locator('#emi-disclaimer').textContent(),/Screening estimate, not a compliance measurement/);
  assert.equal(await pressed(),'E1');
  assert.equal(await page.locator('#emi-chart svg.emi-spectrum').count(),1);
  assert((await page.locator('#emi-chart .emi-limit').count())>=2,'both limit lines');
  assert((await page.locator('#emi-detail').textContent()).includes('9.96 nH'));
  await page.screenshot({path:'test-results/emi-loop.png'});
  // The layer toggles; the board does not change.
  await page.locator('#show-emi').uncheck();await page.locator('#show-emi').check();
  // Selecting a finding in the panel highlights it and, with the proximity finding, shows the victim distance in the panel.
  await page.locator('.emi-item[data-id="E4"]').click();
  assert.equal(await pressed(),'E4');assert((await page.locator('#emi-detail').textContent()).includes('2.42 mm'));
  // Clicking the faint hot loop of E1 on the board selects E1: find one of its pixels on the canvas.
  const spot=await page.evaluate(()=>{const c=document.getElementById('board-canvas'),x=c.getContext('2d'),r=c.getBoundingClientRect(),d=devicePixelRatio||1,img=x.getImageData(0,0,c.width,c.height).data;
    const hits=[];for(let y=0;y<c.height;y++)for(let xx=0;xx<c.width;xx++){const i=(y*c.width+xx)*4;if(Math.abs(img[i]-226)<8&&Math.abs(img[i+1]-145)<14&&Math.abs(img[i+2]-153)<14&&img[i+3]>200)hits.push([xx/d+r.left,y/d+r.top]);}
    return hits.length?hits[Math.floor(hits.length/2)]:null;});
  assert(spot,'the faint hot loop is drawn');await page.mouse.click(spot[0],spot[1]);assert.equal(await pressed(),'E1');
  // Cite the finding in a note and export: the finding and its source are in the review.
  await page.locator('#emi-detail button',{hasText:'Cite in layout note'}).click();
  assert.equal(await page.locator('#emi-ids').inputValue(),'E1');
  await page.locator('#observation').fill('The return of the hot loop takes two vias.');await page.locator('#save-note').click();
  assert.equal(await page.locator('.note-row').count(),1);
  const downloadPromise=page.waitForEvent('download');await page.locator('#export-menu').click();await page.locator('#export-review').click();
  await (await downloadPromise).saveAs('test-results/emi.review.json');
  const review=JSON.parse(readFileSync('test-results/emi.review.json'));
  assert.deepEqual(review.annotations[0].emi_findings,['E1']);assert.equal(review.annotations[0].context.emi_findings[0].code,'EMI-HOT-LOOP');
  assert.equal(review.copperscript_emi.evidence_grade,'screening');assert.equal(review.copperscript_emi.board_verified,false);
  // An older report opens with a note, not an error.
  await page.locator('#any-file').setInputFiles('tests/fixtures/emi-old-schema.route-report.json');
  await page.waitForFunction(()=>[...document.querySelectorAll('#emi-notes li')].some(li=>/traced path/.test(li.textContent)));
  assert.match(await page.locator('#emi-chart').textContent(),/NOT a detector reading/);
  await page.screenshot({path:'test-results/emi-old-schema.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: EMI layer from a served report, panel, spectrum, finding selection and picking, citing and export, older report');
} finally {await browser.close();}
