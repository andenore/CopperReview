/* Real Canvas pixel checks for continuous track copper, including transparency. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE || 'playwright');
const url=process.argv[2];assert(url && new URL(url).hostname==='127.0.0.1');
const browser=await chromium.launch({headless:true,...(process.env.COPPER_BROWSER_EXECUTABLE?{executablePath:process.env.COPPER_BROWSER_EXECUTABLE}:{})});
mkdirSync('test-results',{recursive:true});
const scene=JSON.parse(readFileSync(new URL('../examples/demo.scene.json',import.meta.url)));
scene.components=[];scene.zones=[];scene.drawings=[];scene.vias=[];
for(const net of scene.nets)net.pads=[];
const track=(id,points,width=1.2,net='GND',layer='F.Cu')=>({id,net,layer,width_mm:width,points_mm:points});
scene.tracks=[
  track('straight',[[5,6],[15,6]]),track('bend',[[15,6],[20,11],[29,11]]),
  track('branch',[[15,6],[15,11]]),
  track('thin',[[5,18],[15,18]],.8),track('wide',[[15,18],[29,18]],1.6),
  track('tee',[[15,18],[15,23]],.8),track('cross',[[23,15],[23,21]],.8),
  track('zero-length',[[35,18],[35,18]],1.6),
  track('other-net',[[5,28],[29,28]],1.2,'SENSOR_SCL'),
  track('back-layer',[[5,31],[29,31]],1.2,'GND','B.Cu')
];
// Stay off the screen grid dots when comparing translucent copper pixels.
const interior=[[8,6],[15,6],[20,11],[25,11],[15,9],[8,18],[15,18],[20,18],[23,18],[25,18],[15,21],[35,18]].map(([x,y])=>[x+.13,y+.13]);
try {
  for(const dpr of [1,2]) {
    const page=await browser.newPage({viewport:{width:1520,height:1020},deviceScaleFactor:dpr});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      // Keep repeated pixel reads on one raster backend; Chrome can otherwise
      // switch from GPU to CPU mid-test and change edge rounding by a byte.
      const getContext=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(kind,options){return getContext.call(this,kind,kind==='2d'?{...options,willReadFrequently:true}:options);};
    });
    await page.goto(url);
    const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    let box,zoom,offset;
    const screen=([x,y])=>[box.x+offset[0]+x*zoom,box.y+offset[1]+y*zoom];
    async function load(value){
      await page.locator('#any-file').setInputFiles({name:'joints.scene.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
      await page.waitForFunction(()=>document.querySelector('#component-count').textContent==='0');
      await page.locator('#fit').click();await page.mouse.move(10,10);await settle();
      box=await page.locator('#board-canvas').boundingBox();zoom=Math.min((box.width-80)/50,(box.height-80)/35);
      offset=[box.width/2-25*zoom,(box.height-20)/2-17.5*zoom];
    }
    async function pixel(point){const [sx,sy]=screen(point);return page.locator('#board-canvas').evaluate((canvas,{sx,sy})=>{
      const b=canvas.getBoundingClientRect();return Array.from(canvas.getContext('2d').getImageData(Math.floor((sx-b.x)*canvas.width/b.width),Math.floor((sy-b.y)*canvas.height/b.height),1,1).data);
    },{sx,sy});}
    async function uniform(){const reference=await pixel(interior[0]);for(const point of interior)assert.deepEqual(await pixel(point),reference,`Junction ${point} must match straight copper at DPR ${dpr}`);return reference;}
    async function raster(){return createHash('sha256').update(await page.locator('#board-canvas').evaluate(canvas=>{
      // Include antialiased boundaries: duplicate/reversed contours cannot change
      // either the edge coverage or the interior of the copper union.
      return canvas.toDataURL();
    })).digest('hex');}
    await load(scene);const normal=await uniform(),before=await raster();
    const repeated=structuredClone(scene);
    repeated.tracks=[...scene.tracks].reverse().concat(scene.tracks.map(t=>({...t,id:`reverse-${t.id}`,points_mm:[...t.points_mm].reverse()})));
    await load(repeated);await uniform();
    assert.deepEqual(await raster(),before,'Duplicate/reversed tracks must not introduce bright joints or edge seams');
    // A remote hovered net dims all GND segments equally, including branches.
    await page.mouse.move(...screen([10,28]));await settle();
    assert.equal(await page.locator('#board-canvas').getAttribute('data-hover-net'),'SENSOR_SCL');
    const dimmed=await uniform();assert(dimmed[3]<normal[3]);
    await page.mouse.move(...screen([8,6]));await settle();
    const focused=await uniform();assert.deepEqual(focused,[255,240,182,255]);
    // The same cached geometry stays solid at inspection zoom and after pan.
    const anchor=[15.13,18.13],nearbyPoint=[16.13,18.13];await page.mouse.move(...screen(anchor));await page.mouse.wheel(0,-500);await settle();
    const anchorScreen=screen(anchor);zoom*=Math.exp(.75);
    offset=[anchorScreen[0]-box.x-anchor[0]*zoom,anchorScreen[1]-box.y-anchor[1]*zoom];
    const atZoom=await pixel(anchor),nearby=await pixel(nearbyPoint);assert.deepEqual(atZoom,nearby);
    const [px,py]=screen(anchor);await page.mouse.move(px,py);await page.mouse.down({button:'right'});await page.mouse.move(px+47,py+29);await page.mouse.up({button:'right'});await settle();
    // Map the pan's screen displacement to the fit-coordinate helper.
    offset=[offset[0]+47,offset[1]+29];
    assert.deepEqual(await pixel(anchor),await pixel(nearbyPoint));
    await page.locator('#fit').click();await page.mouse.move(10,10);await settle();
    box=await page.locator('#board-canvas').boundingBox();zoom=Math.min((box.width-80)/50,(box.height-80)/35);
    offset=[box.width/2-25*zoom,(box.height-20)/2-17.5*zoom];
    await page.locator('#layer-list input[data-layer="F.Cu"]').uncheck();await settle();
    assert.equal((await pixel(interior[0]))[3],0,'Hidden-layer tracks must stay hidden');
    assert((await pixel([8,31]))[3]>0,'Other copper layers must remain visible');
    await page.locator('#layer-list input[data-layer="F.Cu"]').check();await settle();await uniform();
    if(dpr===1)await page.screenshot({path:'test-results/track-joints.png',fullPage:true});
    assert.deepEqual(errors,[]);await page.close();
  }
  console.log('Track-joint pixels passed: bends, branches, width changes, crossings, duplicate/reversed and zero-length tracks, hover/dimming, zoom/pan, layers, DPR 1/2.');
} finally {await browser.close();}
