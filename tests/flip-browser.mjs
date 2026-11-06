/* Turning the board over: mirrored picking, readable labels, and Assembly following the side. */
import {mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const {chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE || 'playwright');import assert from 'node:assert/strict';
const url=process.argv[2];const dir='test-results';mkdirSync(dir,{recursive:true});const b=await chromium.launch({headless:true,...(process.env.COPPER_BROWSER_EXECUTABLE?{executablePath:process.env.COPPER_BROWSER_EXECUTABLE}:{})});const p=await b.newPage({viewport:{width:1400,height:900}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
await p.goto(url);await p.evaluate(()=>localStorage.clear());await p.reload();await p.waitForFunction(()=>document.querySelectorAll('.entity').length===4);
const box=await p.locator('#board-canvas').boundingBox();const zoom=Math.min((box.width-80)/50,(box.height-80)/35);
const at=(x,y)=>[box.x+box.width/2+(x-25)*zoom,box.y+(box.height-20)/2+(y-17.5)*zoom];
// Unflipped, U2 (x 36) is right of centre; turned over it sits mirrored at x 14 on screen.
await p.keyboard.press('t');assert.equal(await p.locator('#view-flip').getAttribute('aria-pressed'),'true');
await p.mouse.click(...at(50-36,17));
assert.match(await p.locator('#selection-detail').textContent(),/^U2/);
assert.match(await p.locator('#zoom-status').textContent(),/from back/);
await p.screenshot({path:`${dir}/flip-layout.png`});
// Wheel zoom keeps the point under the pointer.
await p.mouse.move(...at(50-36,17));await p.mouse.wheel(0,-400);await p.waitForTimeout(100);

await p.locator('#fit').click();await p.keyboard.press('t');
// Assembly follows the side: the back-side J1 line turns the board over by itself.
await p.keyboard.press('a');await p.waitForTimeout(200);
assert.equal(await p.locator('#view-flip').getAttribute('aria-pressed'),'false');
for(let i=0;i<3;i++)await p.keyboard.press('j');await p.waitForTimeout(200);
assert.match(await p.locator('#assembly-current').textContent(),/Power in/);
assert.equal(await p.locator('#view-flip').getAttribute('aria-pressed'),'true');
await p.screenshot({path:`${dir}/flip-assembly.png`});
await p.keyboard.press('k');await p.waitForTimeout(100);
assert.equal(await p.locator('#view-flip').getAttribute('aria-pressed'),'false');
assert.deepEqual(errors,[]);await b.close();console.log('flip ok');
