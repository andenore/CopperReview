import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {makeAnnotation,makeReview,validateReview,validateScene,refreshContexts} from '../copper_review/web/core.js';
import {readEmi,emiDocumentKind,assumptionSentences,marginPhrase,findingFacts,findingHeadline,spectrumModel,spectrumSvg,spectrumCaption,loopFromPath,overlayGeometry,overlayAll,pickFinding,emiBrief,emiSource,groupByCell,notModelled,conductedOf,EMI_SCREENING_LINE} from '../copper_review/web/emi.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
// examples/emi-buck.* come from `copper route-board examples/emi_buck/board.copper --allow-proxy-footprints`
// (CopperScript), the report trimmed to its `emi` section; the old-schema file is the same report with the
// fields an earlier CopperScript did not write removed (as in a CopperOrgan run of 2026-11-11).
const json=path=>JSON.parse(readFileSync(new URL(path,import.meta.url)));
const scene=validateScene(json('../examples/emi-buck.scene.json'));
const report=json('../examples/emi-buck.route-report.json');
const old=json('./fixtures/emi-old-schema.route-report.json');
const model=readEmi(report,scene,{name:'route-report.json',sha256:'a'.repeat(64)});
const byCode=(m,code)=>m.findings.filter(f=>f.code===code);

test('a route report is recognised and its emi section parsed into cells and findings',()=>{
  assert.equal(emiDocumentKind(report),'route-report');
  assert.equal(emiDocumentKind(report.emi),'emi-section');
  assert.equal(emiDocumentKind({schema:'copper-review/v2'}),null);
  assert.equal(emiDocumentKind(null),null);
  assert.deepEqual(model.findings.map(f=>f.id),['E1','E2','E3','E4','E5']);
  assert.deepEqual(model.findings.map(f=>f.code),['EMI-HOT-LOOP','EMI-CONDUCTED','EMI-SWITCH-NODE','EMI-PROXIMITY','EMI-PROXIMITY']);
  assert.equal(model.source.evidence_grade,'screening');assert.equal(model.source.board_verified,false);
  const groups=groupByCell(model);assert.equal(groups.length,1);assert.equal(groups[0].name,'U1');assert.equal(groups[0].cell.topology,'buck');assert.equal(groups[0].findings.length,5);
  assert(model.notes.some(n=>/agree on part references/.test(n)&&/no board hash/.test(n)),'says what it could not verify');
  assert.match(EMI_SCREENING_LINE,/Screening estimate, not a compliance measurement/);
  const facts=Object.fromEntries(findingFacts(model.findings[0],model));
  assert.equal(facts['Hot-loop inductance'],'9.96 nH');
  assert.match(facts['Margin'],/^21\.55 dB under the radiated limit/);
  const cond=Object.fromEntries(findingFacts(model.findings[1],model));
  assert.equal(cond['Worst harmonic'],'#1 500 kHz: 95.64 dBuV');
  assert.equal(cond['Against the average limit'],'49.64 dB over the average limit');
  assert.equal(cond['Against the quasi-peak limit'],'39.64 dB over the quasi-peak limit');
  assert.equal(findingHeadline(model.findings[3],model),'FB, 2.42 mm');
  assert(notModelled(model.findings[0]).length>0);
});
test('margin wording is unambiguous about the direction',()=>{
  assert.equal(marginPhrase(-12.34,'average'),'12.34 dB over the average limit');
  assert.equal(marginPhrase(4.1,'quasi-peak'),'4.1 dB under the quasi-peak limit');
  assert.equal(marginPhrase(0.01,'average'),'at the average limit');
});
test('assumption tags become plain sentences, unknown tags fall back to words, duplicates collapse',()=>{
  const s=assumptionSentences(['rule_of_thumb_dc_bias','scenario_current_limit','worst_case_current','something_new_and_odd']);
  assert.equal(s[0],'The current is the switch current limit, a worst case, not a load current.');
  assert.equal(s.filter(x=>x.startsWith('The current is the switch')).length,1);
  assert(s.includes('Capacitor DC-bias derating comes from a rule of thumb.'));
  assert.equal(s[s.length-1],'Something new and odd.');
  assert.deepEqual(assumptionSentences([]),[]);
  assert.deepEqual(assumptionSentences(undefined),[]);
});
test('missing, empty and malformed sections give a note, never an exception',()=>{
  for(const bad of [null,undefined,42,'x',[],{},{schema:'copperscript-route-board/v0.1'},{schema:'copperscript-route-board/v0.1',emi:'text'},{schema:'copperscript-route-board/v0.1',emi:{findings:'no',cells:7}}]){
    const m=readEmi(bad,scene);assert.equal(m.findings.length,0);assert(m.notes.length>=1,JSON.stringify(bad));
  }
  assert.match(readEmi({schema:'copperscript-route-board/v0.1'},scene).notes[0],/no `emi` section.*emi-check BOARD --run RUN --write/);
  assert.match(readEmi({schema:'copperscript-route-board/v0.1',emi:{error:'elaboration failed',evidence_grade:'screening'}}).notes[0],/EMI analysis error: elaboration failed/);
  // A damaged finding is skipped; its neighbours stay.
  const m=readEmi({schema:'copperscript-route-board/v0.1',emi:{findings:[null,{code:'EMI-PROXIMITY',measures:'x',nets:[1,'FB']},{message:'no code'}]}},scene);
  assert.equal(m.findings.length,1);assert.deepEqual(m.findings[0].nets,['FB']);
  assert.doesNotThrow(()=>{for(const f of m.findings){findingFacts(f,m);overlayGeometry(f,scene,m);emiBrief(f);}});
  // A report from another board is flagged, not rejected.
  const other=JSON.parse(JSON.stringify(report));other.emi.cells[0].controller='U99';for(const f of other.emi.findings)f.cell='U99';
  assert(readEmi(other,scene).notes.some(n=>/not on this board/.test(n)&&/U99/.test(n)));
});

test('hot-loop geometry comes from loop_path_3d_mm: solid on the first vertex layer, dashed elsewhere, vias at z steps',()=>{
  const hot=byCode(model,'EMI-HOT-LOOP')[0],loop=overlayGeometry(hot,scene,model).loop;
  assert.equal(loop.source,'loop_path_3d_mm');
  assert.equal(hot.measures.loop_path_3d_mm.length,15);
  assert.equal(loop.segments.length,13,'15 vertices close into 15 steps; the two vertical z steps are vias, not legs');
  assert.equal(loop.segments.filter(s=>!s.solid).length,1);
  const dashed=loop.segments.find(s=>!s.solid);assert.deepEqual(dashed.from,[22,34]);assert.deepEqual(dashed.to,[22.5,29]);
  assert.deepEqual(loop.vias.map(v=>v.at),[[22,34],[22.5,29]]);
  assert.equal(loop.vias[0].from_z,0);assert.equal(loop.vias[0].to_z,-0.5333);
  assert.equal(loop.reference_z,0);assert.deepEqual(loop.levels,[0,-0.5333]);
  assert.deepEqual(loop.segments[0].from,[25.5,29]);assert.deepEqual(loop.segments.at(-1).to,[25.5,29],'the loop closes on its first vertex');
  // The component layer is whatever the first vertex is on.
  const flipped=loopFromPath([[0,0,-1],[4,0,-1],[4,0,0],[4,3,0],[4,3,-1],[0,3,-1]]);
  assert.equal(flipped.reference_z,-1);assert.equal(flipped.vias.length,2);
  assert.equal(flipped.segments.filter(s=>s.solid).length,3,'0,0 to 4,0; 4,3 to 0,3; and the closing leg');
  assert.equal(flipped.segments.filter(s=>!s.solid).length,1);
  assert.equal(loopFromPath([[0,0,0],[1,1,0]]),null);assert.equal(loopFromPath('x'),null);assert.equal(loopFromPath([[0,0],[1,1],[2,2]]),null);
});
test('the overlay frames a hot loop by its own copper, falls back through the pad outline, pad sequence and part boxes',()=>{
  const hot=byCode(model,'EMI-HOT-LOOP')[0],full=overlayGeometry(hot,scene,model);
  assert.deepEqual(full.bounds,[21.5,28.23,28,34.5],'the loop box (22..27.5, 28.73..34) plus 0.5 mm, without the far-away victims');
  assert(full.victims.length>=2&&full.victims.every(v=>v.distance_mm>0),'field victims are flagged with a distance from the loop');
  const strip=keys=>{const f=structuredClone(hot);for(const k of keys)delete f.measures[k];return f;};
  const polygon=overlayGeometry(strip(['loop_path_3d_mm']),scene,model);
  assert.equal(polygon.loop.source,'loop_polygon_mm');assert.equal(polygon.loop.vias.length,0);assert(polygon.notes[0].includes('no traced path'));
  assert.equal(overlayGeometry(strip(['loop_path_3d_mm','loop_polygon_mm']),scene,model).loop.source,'pad_polygon_mm');
  const seq=overlayGeometry(strip(['loop_path_3d_mm','loop_polygon_mm','pad_polygon_mm']),scene,model);
  assert.equal(seq.loop.source,'pad_sequence');assert.equal(seq.loop.segments.length,6,'six loop pads');
  const box=overlayGeometry(strip(['loop_path_3d_mm','loop_polygon_mm','pad_polygon_mm','pad_sequence']),scene,model);
  assert.equal(box.loop.source,'bounds');assert.equal(box.loop.segments.length,4);
  const nothing=structuredClone(strip(['loop_path_3d_mm','loop_polygon_mm','pad_polygon_mm','pad_sequence']));nothing.objects=['U404'];
  assert.equal(overlayGeometry(nothing,scene,model).loop,null,'nothing drawable, nothing thrown');
});
test('switch-node copper and proximity victims are located on the board',()=>{
  const sw=byCode(model,'EMI-SWITCH-NODE')[0],o=overlayGeometry(sw,scene,model);
  assert.deepEqual(o.switchNets,['SW']);assert.equal(o.loop,null);assert(o.bounds[2]>o.bounds[0]);
  const [near,far]=byCode(model,'EMI-PROXIMITY'),a=overlayGeometry(near,scene,model),b=overlayGeometry(far,scene,model);
  assert.equal(a.victims.length,1);
  assert.deepEqual([a.victims[0].source.component,a.victims[0].source.number,a.victims[0].pad.component,a.victims[0].pad.number],['L1','2','R1','2'],'the pair the report names (L1.2 and R1.2)');
  assert.equal(a.victims[0].distance_mm,2.415,'the line carries the report\'s distance');assert.deepEqual(a.switchNets,[]);
  assert.deepEqual([b.victims[0].source.number,b.victims[0].pad.number],['1','2']);assert.deepEqual(b.switchNets,['SW'],'a switch-node source highlights its copper');
  const lost=structuredClone(near);lost.measures.victim='NOPE';
  const l=overlayGeometry(lost,scene,model);assert.equal(l.victims.length,0);assert(l.notes.some(n=>/not found on this board/.test(n)));
});
test('overlay geometry can be picked: the nearest finding within tolerance, else nothing',()=>{
  const overlays=overlayAll(scene,model);
  assert.equal(pickFinding([25.5,29.05],overlays,0.2),'E1');
  assert.equal(pickFinding([22.25,31.5],overlays,0.2),'E1','on the dashed leg on the other layer');
  assert.equal(pickFinding([100,100],overlays,0.5),null);
  const mid=overlays.get('E4').victims[0];
  assert.equal(pickFinding([(mid.from[0]+mid.to[0])/2,(mid.from[1]+mid.to[1])/2],overlays,0.1),'E4');
  assert.equal(pickFinding([25,26.5],overlays,0.2),null,'switch-node copper is no overlay line by itself');
  assert.equal(pickFinding([25,26.5],overlays,0.2,{switchCopper:(net,pt)=>net==='SW'&&Math.abs(pt[0]-25)<0.2&&pt[1]>25&&pt[1]<27.75}),'E3','switch-node copper picks the switch-node finding');
});

test('the conducted spectrum has both limit lines, the worst harmonic and drawn markers',()=>{
  const cond=conductedOf(model,'U1'),spec=spectrumModel(cond,model);
  assert.equal(spec.harmonics.length,60);assert.equal(spec.showLimits,true);assert.equal(spec.limitClass,'B');
  assert.equal(spec.harmonics[spec.worstIndex].frequency_hz,500000);
  assert.deepEqual([spec.lines.qp[0],spec.lines.qp.at(-1)],[[150e3,66],[30e6,60]]);assert.deepEqual([spec.lines.avg[0],spec.lines.avg.at(-1)],[[150e3,56],[30e6,50]]);
  const svg=spectrumSvg(spec);
  assert(svg.startsWith('<svg')&&svg.endsWith('</svg>'));
  assert.equal((svg.match(/class="emi-limit qp"/g)||[]).length>=1,true);assert(svg.includes('class="emi-limit avg"'));
  assert.equal((svg.match(/class="emi-harmonic/g)||[]).length>=60,true);
  assert(svg.includes('worst harmonic: 500 kHz at 95.64 dBuV')&&svg.includes('49.64 dB over the average limit')&&svg.includes('39.64 dB over the quasi-peak limit'));
  assert(svg.includes('class="emi-worst-ring"')&&svg.includes('class="emi-envelope"')&&svg.includes('class="emi-band"'));
  assert(!/NaN|undefined|Infinity/.test(svg));
  assert.match(spectrumCaption(spec).title,/^U1: conducted emission at the input, switching at 500 kHz/);
  // Without the detector assumption the picture shows line amplitudes only: no limit, no margin.
  const noLimit=structuredClone(cond);noLimit.measures.detector_applicability='not_isolated_lines';noLimit.measures.detector_reason='sidebands overlap';
  const plain=spectrumModel(noLimit,model),plainSvg=spectrumSvg(plain);
  assert.equal(plain.showLimits,false);assert(!plainSvg.includes('emi-limit')&&!plainSvg.includes('dB over'));
  assert(plainSvg.includes('highest line amplitude')&&plainSvg.includes('not a detector reading'));
  assert.match(spectrumCaption(plain).subtitle,/sidebands overlap/);
  assert.equal(spectrumModel(byCode(model,'EMI-HOT-LOOP')[0],model),null);
});
test('a report from before the traced path and scenario fields still opens and draws what it has',()=>{
  const m=readEmi(old,scene,{name:'route-report.json'});
  assert.equal(m.findings.length,5);
  assert(m.notes.some(n=>/^No hot loop in this report has a traced path \(`loop_path_3d_mm`; an older report\)/.test(n)&&/emi-check BOARD --run RUN --write/.test(n)),m.notes.join('|'));
  const hot=byCode(m,'EMI-HOT-LOOP')[0],o=overlayGeometry(hot,scene,m);
  assert.equal(o.loop.source,'loop_polygon_mm');assert(o.loop.segments.length>=3);assert.deepEqual(o.victims,[],'no field victims were recorded');
  const facts=Object.fromEntries(findingFacts(hot,m));assert.equal(facts['Hot-loop inductance'],'9.96 nH');assert(!('Margin' in facts),'no margin was stored, none is invented');
  const cond=conductedOf(m,'U1'),spec=spectrumModel(cond,m);
  assert.equal(spec.harmonics.length,1);assert.equal(spec.showLimits,false,'the report does not state the detector assumption, so no limit lines');
  assert.match(spectrumCaption(spec).subtitle,/does not state that the isolated-line detector assumption holds/);
  assert.doesNotThrow(()=>spectrumSvg(spec));
  for(const f of m.findings){assert.doesNotThrow(()=>{findingFacts(f,m);findingHeadline(f,m);overlayGeometry(f,scene,m);emiBrief(f);notModelled(f);});}
  assert.deepEqual(findingFacts(m.findings[2],m).length>0,true);
});

test('an annotated EMI finding reaches the exported review, with its source, and survives a reload',()=>{
  const overlays=overlayAll(scene,model),brief=id=>emiBrief(model.findings.find(f=>f.id===id),overlays.get(id));
  const note=makeAnnotation(scene,{components:[],nets:[],region:overlays.get('E1').bounds},['F.Cu'],
    {category:'placement',priority:'high',observation:'E1: CIN is far from U1; the return goes through two vias.',desired_behavior:'Shorten the hot loop.',boardWide:false,emi:[brief('E1'),brief('E4')]});
  assert.deepEqual(note.emi_findings,['E1','E4']);
  assert.equal(note.context.emi_findings[0].code,'EMI-HOT-LOOP');assert.equal(note.context.emi_findings[0].key_measures.loop_inductance_nh,9.964);
  assert.equal(note.context.emi_findings[1].key_measures.distance_mm,2.415);assert.equal(note.context.emi_findings[0].window_mm.length,4);
  assert.equal(note.issues,undefined,'no CopperScript issue is cited');
  // A note may cite only a finding, with no geometry selected.
  const only=makeAnnotation(scene,{components:[],nets:[],region:null},[],{category:'other',priority:'low',observation:'Look at E3.',desired_behavior:'',boardWide:false,emi:[brief('E3')]});
  assert.deepEqual(only.emi_findings,['E3']);
  assert.throws(()=>makeAnnotation(scene,{components:[],nets:[],region:null},[],{category:'other',priority:'low',observation:'x',desired_behavior:'',boardWide:false}),/Select a component, net, region, cite an issue or EMI finding/);
  const review=makeReview(scene,[note,only],'fully_routed','',null,emiSource(model));
  assert.equal(review.schema,'copper-review/v2');
  assert.equal(review.copperscript_emi.schema,'copperscript-emi-check/v0.1');assert.equal(review.copperscript_emi.report_schema,'copperscript-route-board/v0.1');
  assert.equal(review.copperscript_emi.evidence_grade,'screening');assert.equal(review.copperscript_emi.board_verified,false);assert.equal(review.copperscript_emi.report_sha256,'a'.repeat(64));
  assert.equal(review.copperscript_emi.file,'route-report.json');assert(!JSON.stringify(review).match(/[A-Za-z]:\\|\/Users\//),'no local path in the export');
  const text=JSON.stringify(review),back=validateReview(JSON.parse(text),scene);
  assert.deepEqual(back.annotations.map(a=>a.emi_findings),[['E1','E4'],['E3']]);
  const refreshed=refreshContexts(scene,back.annotations);
  assert.equal(refreshed[0].context.emi_findings[1].id,'E4','cited briefs are kept when contexts are rebuilt');assert.equal(refreshed[0].context.format,'compact/v2');
  // Without a cited finding the export carries no emi source.
  const plain=makeAnnotation(scene,{components:['U1'],nets:[],region:null},['F.Cu'],{category:'routing',priority:'low',observation:'x',desired_behavior:'',boardWide:false});
  assert.equal(makeReview(scene,[plain],'placed','',null,emiSource(model)).copperscript_emi,undefined);
  assert.equal(plain.emi_findings,undefined);
  const broken=JSON.parse(text);broken.annotations[0].emi_findings=[3];
  assert.throws(()=>validateReview(broken,scene),/Invalid review annotation fields/);
});
test('the example review with a cited EMI finding loads against its board',()=>{
  const review=validateReview(json('../examples/emi-buck.review.json'),scene);
  assert.deepEqual(review.annotations[0].emi_findings,['E1']);assert.equal(review.copperscript_emi.board_verified,false);
  assert.equal(refreshContexts(scene,review.annotations)[0].context.emi_findings[0].code,'EMI-HOT-LOOP');
});
