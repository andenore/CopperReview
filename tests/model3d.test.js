import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseVrml,resolveModelPath,pickModel,placement,buildSoup,modelPaths,WRL_UNIT_MM} from '../copper_review/web/model3d.js';
import {cameraEye} from '../copper_review/web/view3d.js';

const wrl=readFileSync(new URL('./fixtures/chip-0805.wrl',import.meta.url),'utf8');
const SCALE=1/2.54;
const chip={reference:'C1',position_mm:[10,20],rotation_deg:0,side:'front',
  body_model:'${KIPRJMOD}/CopperScript.3dshapes/chip.wrl',
  models:[{path:'${KIPRJMOD}/CopperScript.3dshapes/chip.wrl',offset_mm:[0,0,0],scale:[SCALE,SCALE,SCALE],rotate_deg:[0,0,0]}]};
const scene=components=>({board:{bounds_mm:[0,0,40,30]},components});
const extent=(positions,axis)=>{const v=[];for(let i=axis;i<positions.length;i+=3)v.push(positions[i]);return [Math.min(...v),Math.max(...v)];};

test('parses the generated body: a body and terminals, every face a triangle', () => {
  const {parts,unsupported}=parseVrml(wrl);
  assert.equal(unsupported,false);
  assert.deepEqual(parts.map(p=>p.name),['body','terminals']);
  assert.equal(parts[0].triangles.length,36);
  assert.equal(parts[1].triangles.length,72);
  assert.ok(parts[0].color.every(c=>c>=0&&c<=1));
});

test('rejects non-VRML and out-of-range indices', () => {
  assert.throws(()=>parseVrml('<svg/>'));
  assert.throws(()=>parseVrml('#VRML V2.0 utf8\nShape { geometry IndexedFaceSet { coord Coordinate { point [ 0 0 0, 1 0 0, 0 1 0 ] } coordIndex [ 0, 1, 7, -1 ] } }'));
  assert.throws(()=>parseVrml('#VRML V2.0 utf8\nShape { geometry IndexedFaceSet { coord Coordinate { point [ 0 0 ] } coordIndex [ ] } }'));
});

test('only .3dshapes WRL files beside the board are fetchable', () => {
  assert.equal(resolveModelPath('${KIPRJMOD}/CopperScript.3dshapes/a.wrl'),'CopperScript.3dshapes/a.wrl');
  assert.equal(resolveModelPath('X.3dshapes/a.WRL'),'X.3dshapes/a.WRL');
  for(const bad of ['${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R.step','${KIPRJMOD}/a.3dshapes/b.step','/etc/x.3dshapes/a.wrl','a/b/c.wrl','X.3dshapes/../a.wrl','X.3dshapes\a.wrl',null,undefined])
    assert.equal(resolveModelPath(bad),null,String(bad));
});

test('a source STEP model falls back to the generated body, flagged approximate', () => {
  const step={reference:'U1',position_mm:[0,0],side:'front',body_model:'${KIPRJMOD}/CopperScript.3dshapes/u.wrl',
    models:[{path:'${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC.step',offset_mm:[0,0,0],scale:[1,1,1],rotate_deg:[0,0,0]}]};
  assert.deepEqual(pickModel(step),{path:'CopperScript.3dshapes/u.wrl',model:{offset_mm:[0,0,0],scale:[1,1,1],rotate_deg:[0,0,0]},approximate:true});
  assert.equal(pickModel({reference:'X',models:[]}),null);
  assert.equal(pickModel(chip).approximate,true);
  assert.equal(pickModel({...chip,body_model:undefined}).approximate,false);
});

test('KiCad scale 1/2.54 on a millimetre file gives millimetres in the world', () => {
  const {positions}=buildSoup(scene([chip]),new Map([['CopperScript.3dshapes/chip.wrl',parseVrml(wrl)]]));
  // The slab is 6 quads (36 vertices); the chip follows.
  const chipPositions=positions.slice(36*3);
  const [x0,x1]=extent(chipPositions,0),[y0,y1]=extent(chipPositions,1),[z0,z1]=extent(chipPositions,2);
  assert.ok(Math.abs((x1-x0)-2.0)<1e-5,`length ${x1-x0}`);
  assert.ok(Math.abs((y1-y0)-1.25)<1e-5,`width ${y1-y0}`);
  assert.ok(Math.abs(z1-z0-0.85)<1e-5&&Math.abs(z0)<1e-6,`height ${z0}..${z1}`);
  assert.ok(Math.abs((x0+x1)/2-10)<1e-5&&Math.abs((y0+y1)/2+20)<1e-5,'centred on the placement, y up');
  assert.equal(WRL_UNIT_MM,2.54);
});

test('rotation is counter-clockwise on the page and back parts hang below the board', () => {
  const at=(rot,side)=>placement({position_mm:[10,20],rotation_deg:rot,side},{scale:[1,1,1],offset_mm:[0,0,0],rotate_deg:[0,0,0]});
  const p=at(90,'front')([1/WRL_UNIT_MM,0,0]); // 1 mm along +x
  assert.ok(Math.abs(p[0]-10)<1e-9&&Math.abs(p[1]-(-20+1))<1e-9,p.join());
  const back=at(0,'back')([1/WRL_UNIT_MM,0,1/WRL_UNIT_MM]);
  assert.ok(Math.abs(back[0]-9)<1e-9&&Math.abs(back[2]-(-1.6-1))<1e-9,back.join());
});

test('summary counts drawn, approximate and missing components', () => {
  const other={...chip,reference:'C2',body_model:undefined,models:[]};
  const soup=buildSoup(scene([chip,other]),new Map([['CopperScript.3dshapes/chip.wrl',parseVrml(wrl)]]));
  assert.deepEqual(soup.summary,{components:2,drawn:1,approximate:1,missing:1});
  assert.deepEqual(modelPaths(scene([chip,other])),['CopperScript.3dshapes/chip.wrl']);
  assert.equal(soup.positions.length,soup.normals.length);
  assert.equal(soup.positions.length,soup.colors.length);
});

test('the default camera looks north from the bottom of the page', () => {
  const eye=cameraEye({target:[0,0,0],distance:10,yaw:0,pitch:Math.PI/4});
  assert.ok(Math.abs(eye[0])<1e-9&&eye[1]<0&&eye[2]>0);
});
