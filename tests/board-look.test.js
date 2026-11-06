import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {outlineLoops,pasteSides,pasteRecorded,bodyBox} from '../copper_review/web/board-look.js';
const scene=JSON.parse(readFileSync(new URL('../examples/demo.scene.json',import.meta.url)));

test('the outline keeps closed shapes and chains open runs in either direction',()=>{
  const loops=outlineLoops(scene.drawings);
  assert.equal(loops.length,3,'board rectangle and two mounting holes');
  const runs=[{layer:'Edge.Cuts',points:[[0,0],[10,0]]},{layer:'Edge.Cuts',points:[[10,10],[10,0]]},{layer:'Edge.Cuts',points:[[10,10],[0,10],[0,0]]},{layer:'F.SilkS',points:[[1,1],[2,2]]}];
  const [loop]=outlineLoops(runs);
  assert.deepEqual(loop,[[0,0],[10,0],[10,10],[0,10],[0,0]]);
  assert.equal(outlineLoops([{layer:'Edge.Cuts',points:[[0,0],[10,0]]}]),null,'an open outline falls back');
  assert.equal(outlineLoops([]),null);
});

test('paste follows the recorded stencil layers, and is assumed on outer SMD pads for older scenes',()=>{
  const c1=scene.components.find(c=>c.reference==='C1'),j1=scene.components.find(c=>c.reference==='J1');
  assert.deepEqual(pasteSides(c1.pads[0]),['front']);
  assert.deepEqual(pasteSides(j1.pads[0]),[],'through-hole pads get no paste');
  assert(pasteRecorded(scene));
  assert.deepEqual(pasteSides({kind:'smd',layers:['B.Cu']}),['back']);
  assert.deepEqual(pasteSides({kind:'smd',layers:['F.Cu'],paste_layers:[]}),[],'a pad without an aperture stays bare');
  assert.deepEqual(pasteSides({kind:'thru_hole',layers:['F.Cu','B.Cu']}),[]);
});

test('a body comes from the fabrication outline in the footprint frame, else from the pads',()=>{
  const fab={position_mm:[10,10],rotation_deg:90,side:'front',pads:[],
    graphics:[{layer:'F.Fab',points:[[9,8],[11,8],[11,12],[9,12],[9,8]]}]};
  const box=bodyBox(fab);
  // A 2 x 4 mm outline rotated 90 degrees is 4 x 2 mm in the footprint's own frame.
  assert.equal(Math.round(box.w*1000)/1000,4);assert.equal(Math.round(box.h*1000)/1000,2);
  assert.equal(box.angle,90);
  const c1=bodyBox(scene.components.find(c=>c.reference==='C1'));
  assert(c1&&c1.w>c1.h,'pads-only body spans the pads along the part');
  assert.equal(bodyBox({position_mm:[0,0],rotation_deg:0,side:'front',pads:[],graphics:[]}),null);
});
