import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseVrml,occtToBody,candidates,buildSoup,modelPaths,loadBodies} from '../copper_review/web/model3d.js';

const wrl=readFileSync(new URL('./fixtures/chip-0805.wrl',import.meta.url),'utf8');
const extent=(positions,axis)=>{const v=[];for(let i=axis;i<positions.length;i+=3)v.push(positions[i]);return [Math.min(...v),Math.max(...v)];};

// A tiny occt-import-js-shaped mesh: a 2 x 1 x 0.5 mm box, millimetres, one face coloured differently.
function boxMesh() {
  const position=Float32Array.from([0,0,0, 2,0,0, 2,1,0, 0,1,0, 0,0,.5, 2,0,.5, 2,1,.5, 0,1,.5]);
  const index=Uint32Array.from([0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7]);
  return {name:'box',color:[.5,.5,.5],position,index,faces:[{first:0,last:1,color:[1,0,0]},{first:2,last:11,color:null}]};
}
const stepScene=()=>({board:{bounds_mm:[0,0,40,30]},components:[{reference:'J1',position_mm:[10,20],rotation_deg:0,side:'front',
  body_model:'${KIPRJMOD}/CopperScript.3dshapes/J1.wrl',
  models:[{path:'${KIPRJMOD}/CopperScript.3dshapes/abc_J1.step',offset_mm:[0,0,0],scale:[1,1,1],rotate_deg:[0,0,0]}]}]});

test('a STEP mesh becomes millimetre parts, split by face colour', () => {
  const body=occtToBody({meshes:[boxMesh()]});
  assert.equal(body.unit,1);
  assert.equal(body.parts.length,2,'the red face and the grey remainder');
  assert.deepEqual(body.parts.map(p=>p.color),[[1,0,0],[.5,.5,.5]]);
  assert.deepEqual(body.parts.map(p=>p.triangles.length/3),[2,10]);
  const uncoloured=occtToBody({meshes:[{...boxMesh(),faces:[],color:undefined}]});
  assert.equal(uncoloured.parts.length,1);
  assert.equal(uncoloured.parts[0].triangles.length/3,12);
});

test('a broken STEP mesh is refused', () => {
  assert.throws(()=>occtToBody({meshes:[{...boxMesh(),index:Uint32Array.from([0,1,99])}]}),/out of range/);
  assert.throws(()=>occtToBody({meshes:[{...boxMesh(),position:Float32Array.from([0,0])}]}),/triangles/);
  assert.deepEqual(occtToBody({meshes:[]}).parts,[]);
});

test('a STEP body is drawn in millimetres, unlike a VRML body in KiCad units', () => {
  const bodies=new Map([['CopperScript.3dshapes/abc_J1.step',occtToBody({meshes:[boxMesh()]})]]);
  const soup=buildSoup(stepScene(),bodies),box=soup.positions.slice(36*3);
  const [x0,x1]=extent(box,0),[z0,z1]=extent(box,2);
  assert.ok(Math.abs((x1-x0)-2)<1e-5,`length ${x1-x0} (a 2.54 factor would be 5.08)`);
  assert.ok(Math.abs(z1-z0-.5)<1e-5);
  assert.deepEqual(soup.summary,{components:1,drawn:1,approximate:0,missing:0});
});

test('a component prefers its own STEP model and falls back to the generated body', async () => {
  const fetched=[];
  const both=await loadBodies(stepScene(),{
    fetchBody:async path=>{fetched.push(path);return path.endsWith('.step')?occtToBody({meshes:[boxMesh()]}):parseVrml(wrl);},
  });
  assert.deepEqual(fetched.sort(),['CopperScript.3dshapes/J1.wrl','CopperScript.3dshapes/abc_J1.step']);
  assert.equal(buildSoup(stepScene(),both).summary.approximate,0,'the real model wins over the generated one');
  const noStep=await loadBodies(stepScene(),{fetchBody:async path=>path.endsWith('.step')?null:parseVrml(wrl)});
  assert.equal(buildSoup(stepScene(),noStep).summary.approximate,1,'the generated body stands in');
  const throwing=await loadBodies(stepScene(),{fetchBody:async path=>{if(path.endsWith('.step'))throw new Error('no STEP reader');return parseVrml(wrl);}});
  assert.equal(buildSoup(stepScene(),throwing).summary.drawn,1);
});

test('candidates list the models in file order, then the generated body once', () => {
  const list=candidates(stepScene().components[0]);
  assert.deepEqual(list.map(c=>[c.path,c.kind,c.approximate]),[['CopperScript.3dshapes/abc_J1.step','step',false],['CopperScript.3dshapes/J1.wrl','wrl',true]]);
  assert.deepEqual(modelPaths(stepScene()),['CopperScript.3dshapes/J1.wrl','CopperScript.3dshapes/abc_J1.step']);
  const sameFile=candidates({body_model:'${KIPRJMOD}/A.3dshapes/a.wrl',models:[{path:'${KIPRJMOD}/A.3dshapes/a.wrl'}]});
  assert.equal(sameFile.length,1);
});
