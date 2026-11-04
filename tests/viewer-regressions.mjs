/* Pixel regressions for linked fill contours, and real hover/label interactions. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE || 'playwright');
const url=process.argv[2];assert(url && new URL(url).hostname==='127.0.0.1');
const browser=await chromium.launch({headless:true,...(process.env.COPPER_BROWSER_EXECUTABLE?{executablePath:process.env.COPPER_BROWSER_EXECUTABLE}:{})});
const page=await browser.newPage({viewport:{width:1520,height:1020}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));mkdirSync('test-results',{recursive:true});
await page.addInitScript(()=>{
  // Observe the text actually sent to Canvas; no app-state/test API is added.
  const drawText=CanvasRenderingContext2D.prototype.fillText,clear=CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas.id==='board-canvas')window.canvasLabels=[];return clear.apply(this,args);};
  CanvasRenderingContext2D.prototype.fillText=function(text,...args){if(this.canvas.id==='board-canvas')(window.canvasLabels ||= []).push(text);return drawText.call(this,text,...args);};
});
let canvasBox,zoom;
async function fit(){
  await page.locator('#fit').click();await page.mouse.move(10,10);
  canvasBox=await page.locator('#board-canvas').boundingBox();zoom=Math.min((canvasBox.width-80)/50,(canvasBox.height-80)/35);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
function screen([x,y]){return [canvasBox.x+canvasBox.width/2+(x-25)*zoom,canvasBox.y+(canvasBox.height-20)/2+(y-17.5)*zoom];}
async function pixel(point){const [sx,sy]=screen(point);return page.locator('#board-canvas').evaluate((canvas,{sx,sy})=>{
  const box=canvas.getBoundingClientRect();return Array.from(canvas.getContext('2d').getImageData(Math.floor((sx-box.x)*canvas.width/box.width),Math.floor((sy-box.y)*canvas.height/box.height),1,1).data);
},{sx,sy});}
async function settleHover(net){await page.waitForFunction(net=>document.querySelector('#board-canvas').dataset.hoverNet===net,net);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
try {
  await page.goto(url);
  const scene=JSON.parse(readFileSync(new URL('../examples/demo.scene.json',import.meta.url)));
  scene.components[0].pads[2].pin_name='SCL';
  // A native-style outer contour links to a hole and retraces the horizontal
  // bridge. No physical copper edge exists along x=1..42, y=6.
  scene.zones=[{id:'linked-fill',net:'GND',layers:['B.Cu'],kind:'fill',points_mm:
    [[1,1],[49,1],[49,34],[1,34],[1,6],[42,6],[42,10],[46,10],[46,6],[42,6],[1,6],[1,1]]}];
  await page.locator('#any-file').setInputFiles({name:'linked-fill.scene.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(scene))});
  await page.waitForFunction(()=>document.querySelector('#component-count').textContent==='4');
  await fit();
  // Compare the bridge against adjacent filled pixels (all chosen off grid dots).
  const bridge=await pixel([10.13,6]),inside=await pixel([10.13,6.23]),hole=await pixel([44.13,8.13]),outside=await pixel([.13,.13]);
  assert.deepEqual(bridge,inside,'Zero-area hole connectors must not appear as stroked horizontal lines');
  assert.deepEqual(hole,outside,'Stored copper-fill holes must remain empty');
  assert.notDeepEqual(inside,hole,'The filled area itself must still render');
  // Pointing at the board names the net under the cursor but highlights nothing.
  await page.locator('#mode-component').click();await page.mouse.move(...screen([28,18.8]));await settleHover('SENSOR_SCL');
  assert.equal(await page.locator('.entity.selected').count(),0,'Hover must not change the review selection');
  assert((await page.locator('#hover-info').textContent()).includes('Net SENSOR_SCL'));
  for(const point of [[23.65,16.1],[34.45,16.1]])
    assert.notDeepEqual((await pixel(point)).slice(0,3),[255,240,182],`Board hover must not highlight the net at ${point}`);
  await page.mouse.move(...screen([15,21]));await settleHover('GND');
  assert.notDeepEqual((await pixel([7.75,25.27])).slice(0,3),[255,240,182],'Board hover must not highlight remote pads');
  await page.mouse.move(10,10);await settleHover('');
  // Named labels draw at component inspection zoom, stay toggleable, and expose
  // both number and pin/net identity in the always-available pad tooltip.
  await page.getByRole('button',{name:'U1 Controller',exact:true}).click();
  await page.waitForFunction(()=>window.canvasLabels?.includes('3 · SCL'));
  assert(await page.evaluate(()=>window.canvasLabels.includes('4 · SENSOR_SDA')));
  await page.locator('#show-pad-labels').uncheck();
  await page.waitForFunction(()=>!window.canvasLabels?.includes('3 · SCL'));
  await page.locator('#show-pad-labels').check();
  await page.waitForFunction(()=>window.canvasLabels?.includes('3 · SCL'));
  await fit();await page.locator('#clear').click();
  await page.mouse.move(...screen([23.2,16]));await settleHover('SENSOR_SCL');
  assert((await page.locator('#hover-info').textContent()).includes('Pad 3 · SCL'));
  assert((await page.locator('#hover-info').textContent()).includes('Net SENSOR_SCL'));
  // Hover in the explorer highlights the net; hiding its copper layer
  // prevents canvas hover from resurrecting it.
  await page.locator('#tab-nets').click();
  await page.getByRole('button',{name:'SENSOR_SDA 2 pads',exact:true}).hover();await settleHover('SENSOR_SDA');
  assert.deepEqual((await pixel([28,15.2])).slice(0,3),[255,240,182]);
  await page.locator('#layer-list input').first().uncheck();
  await page.mouse.move(...screen([28,18.8]));await settleHover('GND');
  await page.locator('#layer-list input').first().check();
  await page.mouse.move(10,10);await settleHover('');
  await page.screenshot({path:'test-results/viewer-fixed.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: linked-fill bridges disappear, holes remain, pad names/toggle, board hover names without highlighting, explorer hover highlights, selection unchanged, layer filters respected');
} finally {await browser.close();}
