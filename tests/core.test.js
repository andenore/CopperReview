import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {engineeringText,segmentIntersectsBox,regionContext,makeAnnotation,makeReview,validateScene,validateReview,snapshotSelection} from '../copper_review/web/core.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const scene=JSON.parse(readFileSync(new URL('../examples/demo.scene.json',import.meta.url)));
test('engineering labels display exact fixed-point fractions and units',()=>{
  assert.equal(engineeringText('1E+2 nF'),'100 nF');
  assert.equal(engineeringText('1.25E-3 mm'),'0.00125 mm');
  assert.equal(engineeringText('-4.70E+1 kohm'),'-47.0 kohm');
});
test('crossing tracks are selected even when both endpoints are outside the region',()=>{
  assert(segmentIntersectsBox([0,5],[10,5],[4,4,6,6]));
  assert(!segmentIntersectsBox([0,0],[10,0],[4,4,6,6]));
  assert(segmentIntersectsBox([0,0],[10,10],[4,4,6,6]));
});
test('region captures stroke crossings, layered pads and containing fills',()=>{
  const region=regionContext(scene,[25,18.7,27,18.9],['F.Cu']);
  assert(region.tracks.some(t=>t.id==='scl-2'));
  assert.deepEqual(region.nets,['SENSOR_SCL']);
  assert.equal(region.zones.length,0);
  assert(regionContext(scene,[20,20,21,21],['B.Cu']).zones.some(z=>z.kind==='fill'));
});
test('annotation stores hierarchy, exact net endpoints, selection and observation',()=>{
  const selection={components:['U1'],nets:['SENSOR_SCL'],region:[22,14,28,20]};
  const note=makeAnnotation(scene,selection,['F.Cu'],{category:'routing',priority:'high',observation:'Package exits cross.',desired_behavior:'Preserve exit order.',boardWide:false});
  assert.equal(note.context.components[0].source_path,'control.U1');
  assert.equal(note.context.nets[0].tracks.length,3);
  assert(note.context.region.context.nets.includes('SENSOR_SDA'));
  assert.equal(note.context.nets[0].pads[0].position_mm[0],23.2);
  selection.components.push('U2');assert.deepEqual(note.selection.components,['U1']);
});
test('review round trip binds exact board revision and rejects a different file',()=>{
  const note=makeAnnotation(scene,{components:[],nets:[],region:null},['F.Cu'],{category:'algorithm',priority:'medium',observation:'Add a placement comparison.',desired_behavior:'Compare repeated solver seeds.',boardWide:true});
  const review=makeReview(scene,[note],'partially_routed','Improve package escape');
  assert.equal(validateReview(JSON.parse(JSON.stringify(review)),scene).annotations[0].observation,note.observation);
  assert.throws(()=>validateReview(review,{...scene,board:{...scene.board,sha256:'b'.repeat(64)}}),/different board revision/);
});
test('empty annotations require a selection or explicit board-wide intent',()=>{
  assert.throws(()=>makeAnnotation(scene,{components:[],nets:[],region:null},[],{observation:'',desired_behavior:''}),/observation/);
  assert.throws(()=>makeAnnotation(scene,{components:[],nets:[],region:null},[],{observation:'Needs changes',desired_behavior:''}),/Select/);
});
test('net snapshot includes geometry on hidden layers but records visible-layer scope',()=>{
  const context=snapshotSelection(scene,{components:[],nets:['GND'],region:null},['F.Cu']);
  assert(context.nets[0].zones.some(z=>z.layers.includes('B.Cu')));
});
test('scene validation rejects non-mm coordinates and invalid pad geometry',()=>{
  assert.equal(validateScene(scene),scene);
  const bad=JSON.parse(JSON.stringify(scene));bad.board.coordinates.units='nm';
  assert.throws(()=>validateScene(bad),/geometry/);
  bad.board.coordinates.units='mm';bad.components[0].pads[0].size_mm=[-1,1];
  assert.throws(()=>validateScene(bad),/geometry/);
});
