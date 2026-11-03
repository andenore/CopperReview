/* Optional read-only smoke test against an actual CopperScript PCB export. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE || 'playwright');
const [url,filename]=process.argv.slice(2);assert(url && filename);
const browser=await chromium.launch({headless:true,...(process.env.COPPER_BROWSER_EXECUTABLE?{executablePath:process.env.COPPER_BROWSER_EXECUTABLE}:{})});
const page=await browser.newPage({viewport:{width:1600,height:1040}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));mkdirSync('test-results',{recursive:true});
try {
  await page.goto(url);
  await page.locator('#any-file').setInputFiles(filename);
  await page.waitForFunction(()=>Number(document.querySelector('#component-count').textContent)>10);
  assert((await page.locator('#board-meta').textContent()).includes('tracks'));
  await page.locator('#layer-list input').first().uncheck();
  await page.locator('#layer-list input').first().check();
  await page.locator('.entity').nth(5).click();
  await page.locator('#observation').fill('Read-only browser integration smoke test of this component.');
  await page.locator('#save-note').click();
  const downloadPromise=page.waitForEvent('download');await page.locator('#export-menu').click();await page.locator('#export-review').click();
  await (await downloadPromise).saveAs('test-results/real-board.review.json');
  const review=JSON.parse(readFileSync('test-results/real-board.review.json'));
  assert(review.annotations[0].context.components[0].pads.length>0);
  assert(review.board.layers.length>=2);
  assert.equal(review.board.sha256,createHash('sha256').update(readFileSync(filename)).digest('hex'));
  await page.locator('#fit').click();await page.screenshot({path:'test-results/real-board.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(`PASS: real board upload/render/selection/export, ${review.geometry_counts.components} components, ${review.geometry_counts.track_segments} tracks, ${review.geometry_counts.vias} vias, ${review.board.layers.length} layers`);
} finally {await browser.close();}
