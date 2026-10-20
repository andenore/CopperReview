import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {padLabel,engineeringText,segmentIntersectsBox,regionContext,makeAnnotation,makeReview,validateScene,validateReview,snapshotSelection,clipPolygonToBox,polygonArea,refreshContexts,CONTEXT_LIMITS,validateIssues} from '../copper_review/web/core.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const scene=JSON.parse(readFileSync(new URL('../examples/demo.scene.json',import.meta.url)));
test('pad labels use pin names with truthful net and number fallbacks for older scenes',()=>{
  assert.equal(padLabel({number:'3',pin_name:'SCL',net:'I2C_SCL'}),'3 · SCL');
  assert.equal(padLabel({number:'3',net:'I2C_SCL'}),'3 · I2C_SCL');
  assert.equal(padLabel({number:'NC',net:''}),'NC');
});
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
  assert.equal(note.context.nets[0].tracks_by_layer['F.Cu'].segments,3);
  assert(note.context.nets[0].tracks_by_layer['F.Cu'].length_mm>0);
  assert(note.context.region.context.nets.includes('SENSOR_SDA'));
  assert.equal(note.context.nets[0].pads[0].position_mm[0],23.2);
  assert.equal(note.context.nets[0].pads[0].component,'U1');
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
  assert(context.nets[0].zones.some(z=>z.layers.includes('B.Cu') && z.point_count>=3 && z.area_mm2>0 && !z.points_mm));
});
test('scene validation rejects non-mm coordinates and invalid pad geometry',()=>{
  assert.equal(validateScene(scene),scene);
  const bad=JSON.parse(JSON.stringify(scene));bad.board.coordinates.units='nm';
  assert.throws(()=>validateScene(bad),/board\.coordinates\.units must be "mm"/);
  bad.board.coordinates.units='mm';bad.components[0].pads[0].size_mm=[-1,1];
  assert.throws(()=>validateScene(bad),/components\[0\] \(U1\)\.pads\[0\] \(1\)\.size_mm must be two positive/);
});
test('scene validation names a repeated reference and accepts renamed native references',()=>{
  const blank=JSON.parse(JSON.stringify(scene));blank.components[0].reference='';blank.zones[0].points_mm=[[0,0]];
  assert.equal(validateScene(blank),blank);
  const dup=JSON.parse(JSON.stringify(scene));dup.components[1].reference=dup.components[0].reference;
  assert.throws(()=>validateScene(dup),/components\[1\] \(U1\)\.reference repeats an earlier component/);
  const renamed=JSON.parse(JSON.stringify(scene));renamed.components[1].native_reference='';renamed.components[1].reference='FP#1';
  assert.equal(validateScene(renamed),renamed);
});

test('clipping keeps only the part of a polygon inside the region',()=>{
  const clipped=clipPolygonToBox([[0,0],[10,0],[10,10],[0,10]],[2,3,4,5]);
  assert.equal(polygonArea(clipped),4);
  assert.deepEqual(clipPolygonToBox([[0,0],[1,0],[1,1]],[5,5,6,6]),[]);
});
function largeScene() {
  // A filled board: one 40k-point fill, a 600-pad BGA, 2000 tracks and 800 vias.
  const big=JSON.parse(JSON.stringify(scene)),fill=[];
  for(let i=0;i<40000;i++){const a=i/40000*Math.PI*2,r=20+Math.sin(i*1.7)*.2;fill.push([25+r*Math.cos(a),17+r*Math.sin(a)]);}
  big.zones.push({id:'big-fill',net:'GND',points_mm:fill,layers:['F.Cu'],kind:'fill'});
  const pads=[];for(let i=0;i<600;i++)pads.push({id:`bga-${i}`,number:`P${i}`,net:i%3?`N${i}`:'GND',pin_name:'',position_mm:[15+(i%25)*.5,7+Math.floor(i/25)*.5],
    size_mm:[.3,.3],rotation_deg:0,shape:'circle',kind:'smd',layers:['F.Cu'],drill_mm:[],roundrect_ratio:0});
  big.components.push({id:'bga',reference:'U9',source_path:'U9',value:'',footprint:'BGA',position_mm:[21,13],rotation_deg:0,side:'front',locked:false,
    bounds_mm:[14.5,6.5,27.5,19.5],graphics:[],pads});
  for(let i=0;i<2000;i++)big.tracks.push({id:`t${i}`,net:`N${i%600}`,points_mm:[[10+i%40*.5,5+i/100],[10.4+i%40*.5,5.3+i/100]],width_mm:.1,layer:'F.Cu'});
  for(let i=0;i<800;i++)big.vias.push({id:`v${i}`,net:'GND',position_mm:[10+i%40*.6,5+Math.floor(i/40)*.6],size_mm:.4,drill_mm:.2,layers:['F.Cu','B.Cu']});
  big.nets.push({name:'NBIG',pads:pads.map(p=>({component:'U9',source_path:'U9',number:p.number,id:p.id,position_mm:p.position_mm,layers:p.layers}))});
  return big;
}
test('annotations stay within a paste-sized budget on a large filled board',()=>{
  const big=largeScene(),size=sel=>JSON.stringify(makeAnnotation(big,sel,['F.Cu','B.Cu'],
    {category:'routing',priority:'high',observation:'x',desired_behavior:'',boardWide:false})).length;
  assert(size({components:[],nets:['GND'],region:null})<16000);
  assert(size({components:['U9'],nets:['NBIG'],region:null})<24000);
  assert(size({components:[],nets:[],region:[20,12,22,14]})<24000);
  const wide=makeAnnotation(big,{components:[],nets:[],region:[0,0,50,35]},['F.Cu','B.Cu'],{category:'routing',priority:'high',observation:'x',desired_behavior:'',boardWide:false});
  assert(JSON.stringify(wide).length<96000);
  assert.equal(wide.context.region.context.truncated.pads,600+scene.components.flatMap(c=>c.pads).filter(p=>p.layers.length).length);
  assert.equal(wide.context.region.context.pads.length,CONTEXT_LIMITS.region_pads);
  const fill=wide.context.region.context.zones.find(z=>z.id==='big-fill');
  assert.equal(fill.point_count,40000);assert(!fill.clipped_points_mm && fill.clipped_point_count>CONTEXT_LIMITS.clipped_points);
});
test('v1 reviews load and their contexts are rebuilt in the compact format',()=>{
  const note=makeAnnotation(scene,{components:['U1'],nets:['GND'],region:[22,14,28,20]},['F.Cu'],{category:'routing',priority:'low',observation:'Old note.',desired_behavior:'',boardWide:false});
  const v1={...makeReview(scene,[{...note,context:{components:[{huge:true}],nets:[],region:null}}],'placed',''),schema:'copper-review/v1'};
  const loaded=validateReview(JSON.parse(JSON.stringify(v1)),scene);
  const refreshed=refreshContexts(scene,loaded.annotations);
  assert.equal(refreshed[0].context.format,'compact/v2');
  assert.equal(refreshed[0].context.components[0].reference,'U1');
  assert.equal(refreshed[0].observation,'Old note.');
  assert.equal(makeReview(scene,refreshed,'placed','').schema,'copper-review/v2');
});

test('CopperScript issue lists bind to the board and annotations cite their ids',()=>{
  const doc={schema:'copperscript.run-issues/v1',run:'build/demo/runs/1',status:'fail',board_sha256:scene.board.sha256,filled_board_sha256:null,omitted:0,
    issues:[{id:'P1',stage:'access',code:'PACKAGE-EXIT-PENDING',title:'2 pads have no exit',count:2,nets:['SENSOR_SCL'],layers:['F.Cu'],objects:['U1.3'],window_mm:[22,14,25,17],markers:2},
            {id:'N1',stage:'native',code:'NATIVE-UNCONNECTED',title:'GND split',count:1,nets:['GND'],window_mm:null,caused_by:'P1'}]};
  const issues=validateIssues(doc,scene);
  assert.equal(issues.source.board_verified,true);assert.equal(issues.issues.length,2);
  assert.throws(()=>validateIssues({...doc,board_sha256:'c'.repeat(64)},scene),/different board revision/);
  assert.throws(()=>validateIssues({...doc,issues:[doc.issues[0],doc.issues[0]]},scene),/issues\[1\]\.id must be a unique/);
  assert.equal(validateIssues({...doc,board_sha256:undefined},scene).source.board_verified,false);
  const note=makeAnnotation(scene,{components:[],nets:[],region:[22,14,25,17]},['F.Cu'],
    {category:'package_escape',priority:'high',observation:'P1 exits blocked by C1.',desired_behavior:'',boardWide:false,issues:[issues.issues[0]]});
  assert.deepEqual(note.issues,['P1']);assert.equal(note.context.issues[0].code,'PACKAGE-EXIT-PENDING');
  const onlyIssue=makeAnnotation(scene,{components:[],nets:[],region:null},[],{category:'algorithm',priority:'low',observation:'N1 follows P1.',desired_behavior:'',boardWide:false,issues:[issues.issues[1]]});
  const review=makeReview(scene,[note,onlyIssue],'partially_routed','',issues.source);
  assert.equal(review.copperscript_issues.run,'build/demo/runs/1');
  const back=validateReview(JSON.parse(JSON.stringify(review)),scene);
  assert.equal(refreshContexts(scene,back.annotations)[1].context.issues[0].id,'N1');
  assert.equal(makeReview(scene,[],'placed','',issues.source).copperscript_issues,undefined);
});

test('review fixes: big zones, closed outlines, edge-touching zones, arcs, capped issue nets, renamed references',()=>{
  const big=JSON.parse(JSON.stringify(scene)),ring=[];
  for(let i=0;i<200000;i++){const a=i/200000*Math.PI*2;ring.push([25+20*Math.cos(a),17+15*Math.sin(a)]);}
  big.zones.push({id:'huge',net:'GND',points_mm:ring,layers:['F.Cu'],kind:'fill'});
  const net=snapshotSelection(big,{components:[],nets:['GND'],region:null},['F.Cu']).nets[0];
  assert(net.zones.some(z=>z.id==='huge' && z.point_count===200000));
  const outline={layer:'Edge.Cuts',width_mm:.1,filled:false,points:[[0,0],[50,0],[50,32],[0,32],[0,0]]};
  const corner=regionContext({...scene,drawings:[outline]},[-1,-1,1,1],['F.Cu']).drawings[0];
  assert.deepEqual(corner.runs_mm,[[[0,32],[0,0],[50,0]]]);
  const touching={id:'edge',net:'GND',points_mm:[[10,0],[20,0],[20,10],[10,10]],layers:['F.Cu'],kind:'fill'};
  const z=regionContext({...scene,zones:[touching]},[20,2,25,4],['F.Cu']).zones[0];
  assert.equal(z.clipped_area_mm2,0);assert(!z.clipped_points_mm);
  assert.deepEqual(clipPolygonToBox([[2,0],[3,0],[2,0]],[0,-1,5,1]),[]);
  const arcs=JSON.parse(JSON.stringify(scene));arcs.tracks.push({id:'arc1',net:'GND',layer:'F.Cu',width_mm:.2,
    points_mm:[[0,0],[.7,.3],[1,1]],arc:{start_mm:[0,0],mid_mm:[.7,.3],end_mm:[1,1]}});
  const layer=snapshotSelection(arcs,{components:[],nets:['GND'],region:null},['F.Cu']).nets[0].tracks_by_layer['F.Cu'];
  assert.equal(layer.arcs,1);
  const issues=validateIssues({schema:'copperscript.run-issues/v1',board_sha256:scene.board.sha256,
    issues:[{id:'N1',code:'X',title:'t',count:9,nets:['A','B','+7 more'],window_mm:null}]},scene);
  assert.deepEqual(issues.issues[0].nets,['A','B']);assert.equal(issues.issues[0].nets_omitted,7);
  const renamed=JSON.parse(JSON.stringify(scene));renamed.components[1].native_reference='';renamed.components[1].reference='Logo#1';
  const old={schema:'copper-review/v1',board:{sha256:scene.board.sha256,stage:'placed'},annotations:[{id:'a',observation:'o',desired_behavior:'',
    category:'other',priority:'low',status:'open',board_wide:false,visible_layers:['F.Cu'],selection:{components:[''],nets:[],region:null}}]};
  assert.deepEqual(validateReview(old,renamed).annotations[0].selection.components,['Logo#1']);
});
