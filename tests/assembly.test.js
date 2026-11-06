import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildAssembly,validateSheet,reconcileProgress,updateEntry,emptyProgress,summarize,lineDone,validateProgress,makeProgress,statusOf,pinOne,ASSEMBLY_SHEET_SCHEMA} from '../copper_review/web/assembly.js';
const scene=JSON.parse(readFileSync(new URL('../examples/demo.scene.json',import.meta.url)));
const digest=n=>String(n).repeat(64).slice(0,64);
const entry=(reference,designator,fields={})=>({reference,designator,part:'P',value:null,manufacturer:'M',mpn:`MPN-${designator}`,footprint:'F',populate:'consigned',
  assembly:'hand-assemble',supplier:null,supplier_part:null,source_url:null,electrical_sha256:digest(1),...fields});
const sheet=(components)=>({schema:ASSEMBLY_SHEET_SCHEMA,board:'Demo',lock:{schema:'copperscript-assembly-lock/v0.4',sha256:digest(2)},components});

test('without a sheet every solderable footprint is fitted by hand, grouped by value and footprint',()=>{
  const a=buildAssembly(scene);
  assert.equal(a.source,'board');
  assert.deepEqual([...a.items.keys()].sort(),['C1','J1','U1','U2']);
  assert.equal(a.items.get('J1').phase,'through-hole');
  assert.equal(a.items.get('C1').phase,'smd-front');
  // SMD before through-hole; the capacitor (smallest body) leads its pass.
  assert.deepEqual(a.phases,['smd-front','through-hole']);
  assert.equal(a.lines[0].items[0].reference,'C1');
  assert.equal(a.lines.at(-1).items[0].reference,'J1');
});

test('a sheet matches by CopperScript path, then designator, and keeps fit routes',()=>{
  const a=buildAssembly(scene,validateSheet(sheet([
    entry('control.U1','U1'),
    entry('U2','U2',{assembly:'supplier-assembled',populate:'supplier',supplier:'jlcpcb',supplier_part:'C1'}),
    entry('C1','C1',{value:'100 nF',mpn:'CL05B104'}),
    entry('J1','J1',{assembly:'do not fit',populate:'none',mpn:null,manufacturer:null}),
    entry('gone.R9','R9')])));
  assert.equal(a.source,'sheet');
  assert.equal(a.items.get('U1').path,'control.U1');
  assert.equal(a.items.get('U2').phase,'supplier');
  assert.equal(a.items.get('J1').phase,'not-fitted');
  assert.equal(a.items.get('C1').value,'100 nF');
  assert.deepEqual(a.unmatched,['gone.R9']);
  assert.deepEqual(a.phases,['smd-front','supplier','not-fitted']);
});

test('identical parts share a line; designators sort naturally',()=>{
  const twin=structuredClone(scene);
  const extra=n=>({...structuredClone(scene.components.find(c=>c.reference==='C1')),id:`c${n}`,reference:`C${n}`,source_path:`C${n}`});
  twin.components.push(extra(10),extra(2));
  const a=buildAssembly(twin);
  const caps=a.lines.find(l=>l.items.some(i=>i.reference==='C1'));
  assert.deepEqual(caps.items.map(i=>i.reference),['C1','C2','C10']);
});

test('the side with fewer hand-placed SMD parts comes first',()=>{
  const flipped=structuredClone(scene);
  for(const c of flipped.components)if(c.reference!=='C1'&&c.reference!=='J1')c.side='back';
  assert.deepEqual(buildAssembly(flipped).phases,['smd-front','smd-back','through-hole']);
  flipped.components.find(c=>c.reference==='U2').side='front';
  assert.deepEqual(buildAssembly(flipped).phases,['smd-back','smd-front','through-hole']);
});

test('sheet validation names the failing entry and field',()=>{
  assert.throws(()=>validateSheet({schema:'other'}),/Not a CopperScript assembly sheet/);
  assert.throws(()=>validateSheet(sheet([entry('C1','C1',{assembly:'maybe'})])),/component 1 \(C1\): assembly/);
  assert.throws(()=>validateSheet(sheet([entry('C1','C1',{electrical_sha256:'x'})])),/electrical_sha256/);
  assert.throws(()=>validateSheet(sheet([entry('C1','C1'),entry('C1','C1')])),/listed twice/);
  assert.throws(()=>buildAssembly(scene,sheet([entry('X.R1','R1')])),/None of the assembly sheet/);
});

test('progress survives only while a part keeps its identity',()=>{
  const first=buildAssembly(scene,sheet([entry('C1','C1'),entry('control.U1','U1')]));
  const progress=emptyProgress(scene);
  updateEntry(progress,first.items.get('C1'),{status:'placed'});
  updateEntry(progress,first.items.get('U1'),{status:'inspected',note:'checked pin 1'});
  const changed=buildAssembly(scene,sheet([entry('C1','C1',{electrical_sha256:digest(3)}),entry('control.U1','U1')]));
  const {progress:kept,reset}=reconcileProgress(JSON.parse(JSON.stringify(progress)),changed,scene);
  assert.deepEqual(reset,['C1']);
  assert.equal(statusOf(kept,'C1'),'todo');
  assert.equal(statusOf(kept,'U1'),'inspected');
  assert.equal(kept.components.U1.note,'checked pin 1');
});

test('a record back at its defaults is dropped, and lines and totals follow the statuses',()=>{
  const a=buildAssembly(scene,sheet([entry('C1','C1'),entry('control.U1','U1'),entry('J1','J1',{assembly:'do not fit',populate:'none'})]));
  const progress=emptyProgress(scene),c1=a.items.get('C1');
  updateEntry(progress,c1,{status:'placed'});
  assert.equal(lineDone(a.lines.find(l=>l.items.includes(c1)),progress),true);
  updateEntry(progress,c1,{status:'todo'});
  assert.deepEqual(progress.components,{});
  updateEntry(progress,a.items.get('U1'),{status:'placed',problem:true});
  const notFitted=a.lines.find(l=>l.phase==='not-fitted');
  assert.equal(lineDone(notFitted,progress),false);
  updateEntry(progress,a.items.get('J1'),{status:'inspected'});
  assert.equal(lineDone(notFitted,progress),true);
  assert.deepEqual(summarize(a,progress),{parts:3,to_place:2,placed:1,fitted:2,inspected:0,problems:1,lines:3,lines_done:2});
  assert.throws(()=>updateEntry(progress,c1,{status:'soldered'}),/Unknown assembly status/);
});

test('exported progress reloads only on the same board file',()=>{
  const s=sheet([entry('C1','C1')]),a=buildAssembly(scene,s),progress=emptyProgress(scene);
  updateEntry(progress,a.items.get('C1'),{status:'placed'});
  const exported=JSON.parse(JSON.stringify(makeProgress(scene,s,progress,a,'2026-11-06T00:00:00Z')));
  assert.equal(validateProgress(exported,scene).components.C1.status,'placed');
  assert.equal(exported.summary.placed,1);
  assert.throws(()=>validateProgress({...exported,board:{sha256:digest(9)}},scene),/different board/);
  assert.throws(()=>validateProgress({...exported,components:{C1:{status:'placed'}}},scene),/no part identity/);
});

test('pin 1 is the pad numbered 1 or A1, never a guess',()=>{
  assert.equal(pinOne(scene.components[0]).number,'1');
  assert.equal(pinOne({pads:[{number:'B2'},{number:'A1'}]}).number,'A1');
  assert.equal(pinOne({pads:[{number:'G'},{number:'S'}]}),null);
});

test('an assembly.lock reads as a sheet: path designators, routes, values from the board',async()=>{
  const {sheetFromLock,kicadReference}=await import('../copper_review/web/assembly.js');
  const lock=JSON.parse(readFileSync(new URL('../examples/demo.assembly.lock',import.meta.url)));
  const fromLock=sheetFromLock(lock,digest(4));
  assert.equal(fromLock.origin,'assembly.lock');
  assert.equal(fromLock.components.find(c=>c.reference==='power.J1').designator,'power_J1');
  const a=buildAssembly(scene,fromLock);
  assert.equal(a.items.get('C1').value,'100 nF','the value comes from the board');
  assert.equal(a.items.get('U2').reviewed,false);
  // The lock and the sheet written from it name each part the same way, so progress carries over.
  const fromSheet=buildAssembly(scene,validateSheet(JSON.parse(readFileSync(new URL('../examples/demo.assembly-sheet.json',import.meta.url)))));
  for(const [ref,item]of a.items)assert.equal(item.identity,fromSheet.items.get(ref).identity,ref);
  assert.equal(kicadReference('1.R'),'U_1_R');
  const route=populate=>sheetFromLock({...lock,selections:[{...lock.selections[0],populate}]},digest(4)).components[0].assembly;
  assert.deepEqual(['supplier','consigned','none'].map(route),['supplier-assembled','hand-assemble','do not fit']);
  assert.throws(()=>route('maybe'),/populate must be/);
  assert.throws(()=>sheetFromLock({...lock,selections:[{...lock.selections[0],electrical_sha256:undefined}]},digest(4)),/electrical_sha256 is missing/);
  // Legacy locks: v0.1 means supplier-assembled, and parts carry no digest of their own.
  const legacy=sheetFromLock({schema:'copperscript-assembly-lock/v0.1',board:'Demo',electrical_sha256:digest(5),selections:[{reference:'control.C1',part:'P',footprint:'F',manufacturer:'M',mpn:'X',reviewed:true}]},digest(4));
  assert.equal(legacy.components[0].assembly,'supplier-assembled');
  assert.equal(buildAssembly(scene,legacy).items.get('C1').identity,'sheet:legacy|X|F');
  assert.throws(()=>sheetFromLock({schema:'other'},digest(4)),/Not a CopperScript assembly lock/);
});
