// Assembly tracking for a manual build: which parts go where, in what order, and how far the
// build has got. Pure data, no DOM, so Node tests cover it. Progress records what the person at
// the bench reported; it never verifies the assembly.

export const ASSEMBLY_SHEET_SCHEMA='copperscript.assembly-sheet/v1';
export const ASSEMBLY_PROGRESS_SCHEMA='copper-review-assembly/v1';
export const ROUTES=['supplier-assembled','hand-assemble','do not fit'];
export const STATUSES=['todo','placed','inspected'];

const PHASES={
  'smd-front':{label:'Front · SMD',hint:'Paste through the stencil, place, reflow'},
  'smd-back':{label:'Back · SMD',hint:'Paste through the stencil, place, reflow'},
  'through-hole':{label:'Through-hole',hint:'Hand-solder after reflow'},
  'supplier':{label:'Fitted by the assembler',hint:'Inspect only'},
  'not-fitted':{label:'Do not fit',hint:'Confirm the footprint is left empty'}};
export const phaseLabel=phase=>PHASES[phase]?.label||phase;
export const phaseHint=phase=>PHASES[phase]?.hint||'';

const DIGEST=/^[0-9a-f]{64}$/;
const text=value=>typeof value==='string'&&value.trim()?value:null;
const naturally=(a,b)=>a.localeCompare(b,'en',{numeric:true,sensitivity:'base'})||(a<b?-1:a>b?1:0);

/** Check a `copperscript.assembly-sheet/v1` document; errors name the failing entry and field. */
export function validateSheet(value){
  if(value?.schema!==ASSEMBLY_SHEET_SCHEMA)throw Error(`Not a CopperScript assembly sheet (expected ${ASSEMBLY_SHEET_SCHEMA}).`);
  if(!Array.isArray(value.components))throw Error('Assembly sheet has no components list.');
  const seen=new Set();
  for(const [index,c]of value.components.entries()){
    const where=`Assembly sheet component ${index+1}${typeof c?.reference==='string'?` (${c.reference})`:''}`;
    for(const field of ['reference','designator'])if(!text(c?.[field]))throw Error(`${where}: ${field} must be a nonempty string.`);
    if(seen.has(c.reference))throw Error(`${where}: reference is listed twice.`);seen.add(c.reference);
    if(!ROUTES.includes(c.assembly))throw Error(`${where}: assembly must be one of ${ROUTES.join(', ')}.`);
    if(!DIGEST.test(c.electrical_sha256||''))throw Error(`${where}: electrical_sha256 must be a SHA-256 hex digest.`);
    for(const field of ['value','manufacturer','mpn','footprint','supplier','supplier_part','source_url'])
      if(c[field]!==null&&c[field]!==undefined&&typeof c[field]!=='string')throw Error(`${where}: ${field} must be a string or null.`);
  }
  return value;
}

const area=b=>Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]);
const throughHole=c=>c.pads.some(p=>p.kind==='thru_hole');
// Without a sheet, a footprint with no solderable pad (a logo, a board outline) is nothing to fit.
const solderable=c=>c.pads.some(p=>['smd','thru_hole','connect'].includes(p.kind));

/**
 * The build plan for a board: lines of identical parts in assembly order. With a sheet, parts
 * match the board by CopperScript path (the footprint's source_path), then by designator; without
 * one, every footprint with solderable pads is fitted by hand and grouped by value and footprint.
 */
export function buildAssembly(scene,sheet=null){
  const byPath=new Map(),byReference=new Map(),byNative=new Map();
  for(const c of scene.components){if(c.source_path)byPath.set(c.source_path,c);byReference.set(c.reference,c);if(c.native_reference!==undefined&&!byNative.has(c.native_reference))byNative.set(c.native_reference,c);}
  const items=[],unmatched=[],used=new Set();
  const add=(c,entry)=>{used.add(c.reference);
    const route=entry?.assembly||'hand-assemble';
    // Shown by the board's own reference, the one on the silkscreen; the sheet's designator is kept.
    const item={reference:c.reference,designator:c.reference,sheet_designator:entry?.designator||null,path:entry?.reference||c.source_path||c.reference,
      value:entry?(entry.value??''):(c.value||''),footprint:entry?(entry.footprint??c.footprint??''):(c.footprint||''),
      manufacturer:entry?.manufacturer||'',mpn:entry?.mpn||'',supplier:entry?.supplier||'',supplier_part:entry?.supplier_part||'',source_url:entry?.source_url||'',
      route,side:c.side==='back'?'back':'front',through_hole:throughHole(c),size:area(c.bounds_mm)};
    // Progress stays with a part only while it is the same part: the reviewed selection when a
    // sheet names it, else what the board says it is.
    item.identity=entry?`sheet:${entry.electrical_sha256}|${item.mpn}|${item.footprint}`:`board:${item.value}|${item.footprint}`;
    item.phase=route==='do not fit'?'not-fitted':route==='supplier-assembled'?'supplier':item.through_hole?'through-hole':`smd-${item.side}`;
    items.push(item);};
  if(sheet){
    for(const entry of sheet.components){
      const c=byPath.get(entry.reference)||byReference.get(entry.designator)||byNative.get(entry.designator);
      if(!c||used.has(c.reference)){unmatched.push(entry.reference);continue;}
      add(c,entry);
    }
    if(!items.length)throw Error('None of the assembly sheet\'s parts are on the open board. Open the sheet made for this board.');
  }else for(const c of scene.components)if(solderable(c))add(c,null);
  const untracked=scene.components.filter(c=>!used.has(c.reference)).map(c=>c.reference);
  // Lines: one per identical part on one side, so a reel is picked once per pass.
  const lines=new Map();
  for(const item of items){
    const key=JSON.stringify([item.phase,item.route,item.value,item.footprint,item.manufacturer,item.mpn]);
    if(!lines.has(key))lines.set(key,{id:key,phase:item.phase,route:item.route,side:item.side,through_hole:item.through_hole,value:item.value,footprint:item.footprint,
      manufacturer:item.manufacturer,mpn:item.mpn,supplier:item.supplier,supplier_part:item.supplier_part,source_url:item.source_url,items:[]});
    lines.get(key).items.push(item);
  }
  // The side with fewer hand-placed SMD parts goes first, so the heavier side reflows last.
  const count=side=>items.filter(i=>i.phase===`smd-${side}`).length;
  const smd=count('back')&&count('back')<count('front')?['smd-back','smd-front']:['smd-front','smd-back'];
  const order=[...smd,'through-hole','supplier','not-fitted'];
  const median=line=>{const sizes=line.items.map(i=>i.size).sort((a,b)=>a-b);return sizes[Math.floor(sizes.length/2)];};
  const sorted=[...lines.values()].map(line=>({...line,items:line.items.sort((a,b)=>naturally(a.designator,b.designator))}))
    // Small, low parts first within a pass; larger bodies would get in the way of the tweezers.
    .sort((a,b)=>order.indexOf(a.phase)-order.indexOf(b.phase)||median(a)-median(b)||naturally(a.value,b.value)||naturally(a.footprint,b.footprint)||naturally(a.items[0].designator,b.items[0].designator));
  const phases=order.filter(phase=>sorted.some(line=>line.phase===phase));
  return {source:sheet?'sheet':'board',board:sheet?.board||null,lock:sheet?.lock||null,lines:sorted,phases,items:new Map(items.map(i=>[i.reference,i])),unmatched,untracked};
}

/** An empty record of progress for the open board. */
export function emptyProgress(scene){return {schema:ASSEMBLY_PROGRESS_SCHEMA,board:{name:scene.board.name,sha256:scene.board.sha256},components:{}};}

/**
 * Keep the saved progress of parts that are still the same part. A part whose identity changed
 * (a new selection, MPN or footprint) starts again; it is listed so the change is never silent.
 */
export function reconcileProgress(saved,assembly,scene){
  const progress=emptyProgress(scene),reset=[];
  for(const [reference,entry]of Object.entries(saved?.components||{})){
    const item=assembly.items.get(reference);
    if(!item||!entry||typeof entry!=='object')continue;
    if(entry.identity!==item.identity){reset.push(reference);continue;}
    progress.components[reference]=normalEntry(entry);
  }
  return {progress,reset};
}
function normalEntry(entry){
  const out={identity:String(entry.identity),status:STATUSES.includes(entry.status)?entry.status:'todo',problem:entry.problem===true,note:typeof entry.note==='string'?entry.note:''};
  if(typeof entry.updated_at==='string')out.updated_at=entry.updated_at;
  return out;
}
export const statusOf=(progress,reference)=>progress.components[reference]?.status||'todo';
export const entryOf=(progress,reference)=>progress.components[reference]||{status:'todo',problem:false,note:''};

/** Change one part's record; a record back at its defaults is dropped. */
export function updateEntry(progress,item,change,now=new Date().toISOString()){
  const next={...entryOf(progress,item.reference),...change,identity:item.identity,updated_at:now};
  if(!STATUSES.includes(next.status))throw Error(`Unknown assembly status ${next.status}.`);
  if(next.status==='todo'&&!next.problem&&!next.note)delete progress.components[item.reference];
  else progress.components[item.reference]=normalEntry(next);
  return progress;
}
/** A line is done once every part is placed (or, for parts not fitted, checked empty). */
export function lineDone(line,progress){
  return line.items.every(i=>{const s=statusOf(progress,i.reference);return line.phase==='not-fitted'||line.phase==='supplier'?s==='inspected':s!=='todo';});
}
export function summarize(assembly,progress){
  const all=[...assembly.items.values()],fitted=all.filter(i=>i.route!=='do not fit'),hand=all.filter(i=>i.route==='hand-assemble');
  const status=i=>statusOf(progress,i.reference);
  return {parts:all.length,to_place:hand.length,placed:hand.filter(i=>status(i)!=='todo').length,fitted:fitted.length,inspected:fitted.filter(i=>status(i)==='inspected').length,
    problems:all.filter(i=>entryOf(progress,i.reference).problem).length,lines:assembly.lines.length,lines_done:assembly.lines.filter(l=>lineDone(l,progress)).length};
}

/** Check an exported progress file before it replaces what this browser holds. */
export function validateProgress(value,scene){
  if(value?.schema!==ASSEMBLY_PROGRESS_SCHEMA)throw Error(`Not a CopperReview assembly progress file (expected ${ASSEMBLY_PROGRESS_SCHEMA}).`);
  if(value.board?.sha256!==scene.board.sha256)throw Error('This assembly progress was recorded for a different board file. Open the board it was made for.');
  if(!value.components||typeof value.components!=='object'||Array.isArray(value.components))throw Error('Assembly progress has no components record.');
  for(const [reference,entry]of Object.entries(value.components)){
    if(!entry||typeof entry!=='object'||typeof entry.identity!=='string')throw Error(`Assembly progress for ${reference} has no part identity.`);
    if(entry.status!==undefined&&!STATUSES.includes(entry.status))throw Error(`Assembly progress for ${reference} has an unknown status.`);
  }
  if(value.sheet!==null&&value.sheet!==undefined)validateSheet(value.sheet);
  return value;
}

/** The portable progress file: the board, the sheet it was tracked against, and every record. */
export function makeProgress(scene,sheet,progress,assembly,now=new Date().toISOString()){
  const summary=summarize(assembly,progress);
  return {schema:ASSEMBLY_PROGRESS_SCHEMA,exported_at:now,board:{name:scene.board.name,filename:scene.board.filename,sha256:scene.board.sha256},
    sheet:sheet||null,summary,components:progress.components,
    limits:['Statuses record what was reported at the bench; they do not verify placement, orientation or solder joints.',
      sheet?'Parts are matched to the board by CopperScript path and designator, not checked against the source the board was built from.':'No assembly sheet: parts and values come from the board file only, without MPNs or fit routes.']};
}

/** Pin 1 of a part, when its pads say so: the pad numbered 1 (or A1), else none. */
export function pinOne(component){return component.pads.find(p=>p.number==='1')||component.pads.find(p=>p.number==='A1')||null;}
