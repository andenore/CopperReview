/* 3D views: number keys and Home snap to named views, 5/O switch projection, the indicator follows and snaps. Needs the browser compiler (npm run fetch:wasm or build:wasm). */
import {mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const {chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE || 'playwright');import assert from 'node:assert/strict';
const url=process.argv[2];const dir='test-results';mkdirSync(dir,{recursive:true});const b=await chromium.launch({headless:true,...(process.env.COPPER_BROWSER_EXECUTABLE?{executablePath:process.env.COPPER_BROWSER_EXECUTABLE}:{})});const p=await b.newPage({viewport:{width:1300,height:850}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
await p.goto(url);await p.evaluate(()=>localStorage.clear());await p.reload();await p.waitForFunction(()=>document.querySelectorAll('.entity').length===4);
assert(await p.locator('#view-gizmo').isHidden());
await p.locator('#view-3d').click();await p.waitForFunction(()=>/^3D:/.test(document.querySelector('#message').textContent),null,{timeout:90000});
await p.waitForFunction(()=>document.querySelector('#view-gizmo').dataset.view);
const view=()=>p.locator('#view-gizmo').getAttribute('data-view');
assert.equal(await view(),'free');await p.screenshot({path:`${dir}/3d-free.png`});
await p.locator('#view3d-canvas').click({position:{x:5,y:300}});
for(const [key,name] of [['7','top'],['1','front'],['3','right'],['Shift+7','bottom'],['Shift+1','back'],['Shift+3','left'],['Home','top']]){
  await p.keyboard.press(key);await p.waitForFunction(n=>document.querySelector('#view-gizmo').dataset.view===n,name);
  if(name==='bottom')assert.equal(await p.locator('#view-flip').getAttribute('aria-pressed'),'true');
  if(name==='front'){await p.keyboard.press('5');await p.waitForTimeout(150);await p.screenshot({path:`${dir}/3d-front-ortho.png`});await p.keyboard.press('5');}
}
assert.equal(await p.locator('#view-flip').getAttribute('aria-pressed'),'false');
await p.keyboard.press('o');await p.waitForTimeout(150);assert.equal(await p.locator('#view-ortho').getAttribute('aria-pressed'),'true');
await p.screenshot({path:`${dir}/3d-top-ortho.png`});
// Clicking the gizmo's +X end snaps to the right view.
const g=await p.locator('#view-gizmo').boundingBox();await p.keyboard.press('1');await p.waitForTimeout(150);
const [ex,ey]=JSON.parse(await p.locator('#view-gizmo').getAttribute('data-ends')).right;await p.mouse.click(g.x+ex,g.y+ey);await p.waitForFunction(()=>document.querySelector('#view-gizmo').dataset.view==='right');
assert.equal(await view(),'right');
await p.screenshot({path:`${dir}/3d-right.png`});
assert.deepEqual(errors,[]);await b.close();console.log('views ok');
