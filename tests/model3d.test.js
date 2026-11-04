import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseVrml,resolveModelPath,pickModel,placement,buildSoup,modelPaths,loadBodies,bodyInputKey,padOutline,BOARD_FEATURE_COLORS,WRL_UNIT_MM} from '../copper_review/web/model3d.js';
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

test('only WRL and STEP files in a .3dshapes folder beside the board are fetchable', () => {
  assert.equal(resolveModelPath('${KIPRJMOD}/CopperScript.3dshapes/a.wrl'),'CopperScript.3dshapes/a.wrl');
  assert.equal(resolveModelPath('X.3dshapes/a.WRL'),'X.3dshapes/a.WRL');
  assert.equal(resolveModelPath('${KIPRJMOD}/CopperScript.3dshapes/0af1_VSSOP-8.step'),'CopperScript.3dshapes/0af1_VSSOP-8.step');
  assert.equal(resolveModelPath('X.3dshapes/a.STP'),'X.3dshapes/a.STP');
  for(const bad of ['${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R.step','${KIPRJMOD}/a.3dshapes/b.txt','/etc/x.3dshapes/a.wrl','a/b/c.wrl','X.3dshapes/../a.wrl','X.3dshapes\\a.wrl',null,undefined])
    assert.equal(resolveModelPath(bad),null,String(bad));
});

test('a source STEP model falls back to the generated body, flagged approximate', () => {
  const step={reference:'U1',position_mm:[0,0],side:'front',body_model:'${KIPRJMOD}/CopperScript.3dshapes/u.wrl',
    models:[{path:'${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC.step',offset_mm:[0,0,0],scale:[1,1,1],rotate_deg:[0,0,0]}]};
  assert.deepEqual(pickModel(step),{path:'CopperScript.3dshapes/u.wrl',model:{offset_mm:[0,0,0],scale:[1,1,1],rotate_deg:[0,0,0]},approximate:true,kind:'wrl'});
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

const input={name:'C_0805',pads:[{number:'1',x_mm:-1,y_mm:0,w_mm:1,h_mm:1.3,kind:'smd'},{number:'2',x_mm:1,y_mm:0,w_mm:1,h_mm:1.3,kind:'smd'}]};
const bare=(reference,side='front')=>({reference,position_mm:[10,20],rotation_deg:0,side,body_input:input});

test('a body-input request carries the schema and is the same for equal footprints', () => {
  const key=bodyInputKey(bare('C1'));
  assert.equal(JSON.parse(key).schema,'copperscript.body-input/v1');
  assert.equal(key,bodyInputKey(bare('C2')));
  assert.equal(bodyInputKey({reference:'X'}),null);
});

test('loadBodies serves what it can and asks CopperScript to generate the rest, once per distinct footprint', async () => {
  const requests=[];
  const bodies=await loadBodies(scene([chip,bare('C2'),bare('C3')]),{
    fetchBody:async path=>path==='CopperScript.3dshapes/chip.wrl'?parseVrml(wrl):null,
    generate:async asked=>{requests.push(...asked);return asked.map(()=>({wrl}));},
  });
  assert.equal(requests.length,1,'C2 and C3 share one request');
  assert.deepEqual([...bodies.keys()].sort(),['CopperScript.3dshapes/chip.wrl','input:'+bodyInputKey(bare('C2'))]);
});

test('with nothing served every component is generated, and a failure leaves it without a body', async () => {
  const ok=await loadBodies(scene([bare('C1')]),{fetchBody:async()=>null,generate:async a=>a.map(()=>({wrl}))});
  assert.equal(buildSoup(scene([bare('C1')]),ok).summary.drawn,1);
  const failed=await loadBodies(scene([bare('C1')]),{fetchBody:async()=>{throw new Error('offline');},generate:async a=>a.map(()=>({error:'bad'}))});
  assert.deepEqual(buildSoup(scene([bare('C1')]),failed).summary,{components:1,drawn:0,approximate:0,missing:1});
  const unsupported=await loadBodies(scene([bare('C1')]),{fetchBody:async()=>null});
  assert.equal(unsupported.size,0);
});

test('a generated body is already millimetres and counts as approximate', async () => {
  const bodies=await loadBodies(scene([bare('C1')]),{fetchBody:async()=>null,generate:async a=>a.map(()=>({wrl}))});
  const soup=buildSoup(scene([bare('C1')]),bodies);
  const chipPositions=soup.positions.slice(36*3);
  const [x0,x1]=extent(chipPositions,0);
  assert.ok(Math.abs((x1-x0)-2.0)<1e-5,`length ${x1-x0} (a 2.54 factor would be 5.08)`);
  assert.equal(soup.summary.approximate,1);
});

test('a generated back-side body hangs below the board without a second mirror', async () => {
  const front=(await loadBodies(scene([bare('F')]),{fetchBody:async()=>null,generate:async a=>a.map(()=>({wrl}))}));
  const back=(await loadBodies(scene([bare('B','back')]),{fetchBody:async()=>null,generate:async a=>a.map(()=>({wrl}))}));
  const f=buildSoup(scene([bare('F')]),front).positions.slice(36*3),b=buildSoup(scene([bare('B','back')]),back).positions.slice(36*3);
  const [fx0,fx1]=extent(f,0),[bx0,bx1]=extent(b,0),[bz0,bz1]=extent(b,2);
  assert.ok(Math.abs(fx0-bx0)<1e-5&&Math.abs(fx1-bx1)<1e-5,'same footprint frame, same x extent');
  assert.ok(Math.abs(bz1-(-1.6))<1e-6&&bz0<-1.6,`z ${bz0}..${bz1}`);
});

test('KiCad library VRML: materials named once and reused after the geometry, texture points skipped', () => {
  const text=`#VRML V2.0 utf8
Shape { geometry IndexedFaceSet { coord Coordinate { point [ 0 0 0, 1 0 0, 0 1 0 ] } coordIndex [ 0, 1, 2, -1 ] }
 appearance Appearance { material DEF PIN-01 Material { diffuseColor 0.8 0.8 0.8 } } }
Shape { geometry IndexedFaceSet { coord Coordinate { point [ 0 0 1, 1 0 1, 0 1 1 ] } coordIndex [ 0, 1, 2, -1 ]
 texCoord TextureCoordinate { point [ 0 0, 1 0, 0 1 ] } }
 appearance Appearance { material DEF IC-BODY Material { diffuseColor 0.1 0.1 0.1 } } }
Shape { geometry IndexedFaceSet { coord Coordinate { point [ 0 0 2, 1 0 2, 0 1 2 ] } coordIndex [ 0, 1, 2, -1 ] }
 appearance Appearance { material USE PIN-01 } }`;
  const {parts}=parseVrml(text);
  assert.equal(parts.length,3,'the texture coordinates are not a fourth part');
  assert.deepEqual(parts.map(p=>p.color.map(c=>+c.toFixed(2))),[[.8,.8,.8],[.1,.1,.1],[.8,.8,.8]]);
});

test('loadBodies reuses a cache across calls: nothing is fetched or generated twice', async () => {
  const cache=new Map();let fetches=0,generated=0;
  const options={cache,fetchBody:async()=>{fetches++;return null;},generate:async a=>{generated+=a.length;return a.map(()=>({wrl}));}};
  const first=await loadBodies(scene([bare('C1')]),options),again=await loadBodies(scene([bare('C1')]),options);
  assert.equal(buildSoup(scene([bare('C1')]),again).summary.drawn,1);assert.equal(first.size,again.size);
  assert.equal(generated,1);
  const failedBatch=new Map();await loadBodies(scene([bare('C1')]),{cache:failedBatch,fetchBody:async()=>null,generate:async()=>[]});
  assert.equal(failedBatch.size,0,'a batch that failed as a whole is retried next time');
});

test('pad outlines keep their size and turn with the pad', () => {
  const box=points=>[0,1].map(a=>{const v=points.map(p=>p[a]);return +(Math.max(...v)-Math.min(...v)).toFixed(6);});
  const pad={position_mm:[5,5],size_mm:[2,1],rotation_deg:0,shape:'rect'};
  assert.deepEqual(box(padOutline(pad)),[2,1]);
  assert.deepEqual(box(padOutline({...pad,rotation_deg:90})),[1,2]);
  assert.deepEqual(box(padOutline({...pad,shape:'oval'})),[2,1]);
  assert.deepEqual(box(padOutline({...pad,shape:'circle',size_mm:[1.5,1.5]})),[1.5,1.5]);
});

test('outer copper, pads, holes and silk sit on their own face; fills come back as polygons', () => {
  const colored=(soup,color)=>{const z=[];for(let i=0;i<soup.colors.length;i+=3)if(soup.colors.slice(i,i+3).every((c,k)=>Math.abs(c-color[k])<1e-6))z.push(soup.positions[i+2]);return z;};
  const board={...scene([{reference:'J1',position_mm:[10,10],rotation_deg:0,side:'front',pads:[
      {position_mm:[10,10],size_mm:[2,2],rotation_deg:0,shape:'rect',layers:['F.Cu','B.Cu'],drill_mm:[1,1]}],
      graphics:[{points:[[8,8],[12,8]],layer:'F.SilkS',width_mm:.12}]}]),
    tracks:[{points_mm:[[0,0],[5,0]],width_mm:.2,layer:'B.Cu'},{points_mm:[[0,1],[5,1]],width_mm:.2,layer:'In1.Cu'}],
    vias:[],zones:[{kind:'fill',layers:['F.Cu'],points_mm:[[0,0],[4,0],[4,4],[0,4]]},{kind:'intent',layers:['F.Cu'],points_mm:[[0,0],[4,0],[4,4]]}],drawings:[]};
  const soup=buildSoup(board,new Map()),C=BOARD_FEATURE_COLORS;
  assert.ok(colored(soup,C.copper).length&&colored(soup,C.copper).every(z=>z<-1.6),'the bottom track is under the board; the inner one is not drawn');
  assert.ok(colored(soup,C.pad).some(z=>z>0)&&colored(soup,C.pad).some(z=>z<-1.6),'a through-hole pad shows on both faces');
  assert.ok(colored(soup,C.hole).length&&colored(soup,C.silk).every(z=>z>0));
  assert.equal(soup.fills.length,1);assert.deepEqual(Array.from(soup.fills[0].points.slice(0,6)),Array.from(Float32Array.of(0,-0,.015,4,-0,.015)));
});
