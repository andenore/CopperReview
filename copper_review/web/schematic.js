/* Generated schematic sheets from the electrical IR. Nothing here is authored drawing
 * intent: power and ground pins become flags, support passives fold into badges, and a
 * net is drawn as a wire only where it cannot cross a symbol; otherwise it gets labels. */
import {isPassive,quantity} from './electrical-model.js';
import {engineeringText} from './core.js';

const PIN=20,HEAD=40,FOOT=16,STUB=18,LANE=10,CHAR=7,TWO=48,HUB=20,MAX_SHEET=36,SLACK=1.2,SMALL=3,BAND=1100,WRAP=1500,SMALL_PINS=4;
const distinct=a=>[...new Set(a)];
const scoped=(scope,s)=>scope?`${scope}/${s}`:s;
const natural=(a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true});
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const outputOnly=p=>p.profile.directions?.includes('output')&&!p.profile.directions.includes('input');
const inputOnly=p=>p.profile.directions?.includes('input')&&!p.profile.directions.includes('output');

export function netRole(model,name){
  const n=model.nets.get(name);if(!n)return 'nc';
  // Declared supplies win. Pins that claim both power and ground (generic headers) say nothing.
  if(n.supplies.some(s=>s.voltage?.base_value==='0'))return 'ground';
  if(n.supplies.length)return 'power';
  // Passive pins (resistors, connectors, FET drains) often claim the power domain generically;
  // only a driven or receiving pin makes an undeclared net a rail.
  const only=(p,domain,other)=>p.profile.domains?.includes(domain)&&!p.profile.domains.includes(other);
  const active=p=>(p.profile.directions||[]).some(d=>d!=='passive');
  const ground=n.pins.filter(p=>only(p,'ground','power')).length,power=n.pins.filter(p=>only(p,'power','ground')&&active(p)).length;
  return ground&&ground>=power?'ground':power?'power':'signal';
}
const pinRole=(model,p)=>p.net?netRole(model,p.net):'nc';
const twoPin=c=>c.pins.length===2;
/** Short drawing values: 4.7k, 33Ω, 100nF, 10µH. */
export function compactQuantity(q){
  if(!q)return '';const v=engineeringText(q.value),unit=String(q.unit||''),ohm=/^([a-zA-Zµ]?)ohms?$/i.exec(unit);
  const base=Number(q.base_value),trim=x=>String(Number(x.toPrecision(6)));
  if(ohm&&q.base_value!=null&&Number.isFinite(base))return base>=1e6?`${trim(base/1e6)}M`:base>=1e3?`${trim(base/1e3)}k`:`${trim(base)}Ω`;
  return ohm?(ohm[1]?`${v}${ohm[1].replace(/^u$/,'µ')}`:`${v}Ω`):`${v}${unit.replace(/^u/,'µ')}`;
}
// Series links: 0 Ω jumpers, damping resistors up to 100 Ω and signal-path inductors or beads.
// Current shunts (≤ 1 Ω) and anything marked as a shunt or sense part stay drawn.
function seriesLink(c){
  const cat=c.partDefinition.category||'',ohms=Number(c.value?.base_value);
  if(/shunt|sense/.test(`${c.properties?.role||''}`))return false;
  if(/resistor/.test(cat))return c.value!=null&&Number.isFinite(ohms)&&(ohms===0||ohms>1&&ohms<=100);
  return /inductor|ferrite|bead/.test(cat)&&!/power/.test(cat);
}

/** Passives folded out of the drawing. Every fold stays listed and selectable. */
function folding(model,showPassives){
  const folded=new Map();if(showPassives)return folded;
  for(const c of model.components.values()){
    // ESD/TVS parts that only clamp signals to rails become a badge on each protected signal.
    if(/^protection\./.test(c.partDefinition.category||'')){
      const nets=distinct(c.pins.map(p=>p.net).filter(Boolean)),signals=nets.filter(n=>netRole(model,n)==='signal');
      if(signals.length&&signals.length<nets.length)folded.set(c.ref,{kind:'protect',ref:c.ref,net:signals[0],nets:signals});
      continue;
    }
    if(!isPassive(c))continue;
    const nets=c.pins.map(p=>p.net);
    if(c.properties?.role==='decoupling'||c.properties?.decouples||nets.some(Boolean)&&nets.filter(Boolean).every(n=>netRole(model,n)!=='signal')){
      const target=typeof c.properties?.decouples==='string'?scoped(c.scope,c.properties.decouples):null,rail=c.pins.map(p=>p.net).find(n=>n&&netRole(model,n)!=='ground')||c.pins.find(p=>p.net)?.net||null;
      folded.set(c.ref,{kind:'support',ref:c.ref,pin:model.pins.has(target)?target:null,net:rail});continue;
    }
    // A series link between two plain signal nets folds; its two nets are drawn as one.
    if(twoPin(c)&&nets.every(Boolean)&&nets[0]!==nets[1]&&nets.every(n=>netRole(model,n)==='signal')&&seriesLink(c)){
      const others=nets.map(n=>model.nets.get(n).pins.filter(p=>p.component!==c.ref));
      if(others.every(o=>o.length&&o.every(p=>!isPassive(model.components.get(p.component)))))folded.set(c.ref,{kind:'series',ref:c.ref,net:nets[0],nets});
      continue;
    }
    // Pull resistors only: shunts and terminations stay drawn.
    if(!twoPin(c)||!nets.every(Boolean)||!/resistor/.test(c.partDefinition.category||'')||!(Number(c.value?.base_value)>=1000))continue;
    const fixed=nets.filter(n=>netRole(model,n)!=='signal'),signal=nets.filter(n=>netRole(model,n)==='signal');
    if(fixed.length!==1||signal.length!==1)continue;
    // Only plain pull resistors: a divider or filter node keeps its passives visible.
    const others=model.nets.get(signal[0]).pins.filter(p=>p.component!==c.ref);
    if(others.length&&others.every(p=>!isPassive(model.components.get(p.component))))folded.set(c.ref,{kind:netRole(model,fixed[0])==='ground'?'pulldown':'pullup',ref:c.ref,net:signal[0],rail:fixed[0]});
  }
  return folded;
}

/** The model as drawn: nets joined by a folded series link become one net under the first name. */
function mergedModel(model,folded){
  const series=[...folded.values()].filter(f=>f.kind==='series'),merged=new Map();if(!series.length)return {view:model,merged};
  const parent=new Map(),find=n=>{while(parent.get(n)!==n)n=parent.get(n);return n;};
  for(const f of series){for(const n of f.nets)if(!parent.has(n))parent.set(n,n);const [a,b]=f.nets.map(find).sort(natural);if(a!==b)parent.set(b,a);}
  const alias=new Map([...parent.keys()].map(n=>[n,find(n)]));
  for(const [n,r]of alias){if(!merged.has(r))merged.set(r,[]);merged.get(r).push(n);}
  const remap=p=>alias.has(p.net)?{...p,net:alias.get(p.net),rawNet:p.net}:p,gone=new Set(series.map(f=>f.ref));
  const components=new Map([...model.components].map(([r,c])=>[r,c.pins.some(p=>alias.has(p.net))?{...c,pins:c.pins.map(remap)}:c]));
  const nets=new Map(model.nets);
  for(const [r,names]of merged){names.sort(natural);const pins=names.flatMap(n=>model.nets.get(n).pins).filter(p=>!gone.has(p.component)).map(remap);nets.set(r,{...model.nets.get(r),name:r,pins,supplies:[],merged:names});for(const n of names)if(n!==r)nets.delete(n);}
  return {view:{...model,components,nets},merged};
}

function components(refs,linked){
  const parent=new Map(refs.map(r=>[r,r])),find=r=>{while(parent.get(r)!==r){parent.set(r,parent.get(parent.get(r)));r=parent.get(r);}return r;};
  for(const group of linked)for(const r of group.slice(1))parent.set(find(r),find(group[0]));
  const out=new Map();for(const r of refs){const k=find(r);if(!out.has(k))out.set(k,[]);out.get(k).push(r);}return [...out.values()];
}

/** Split the board into sheets: module scopes first, then signal connectivity. */
export function schematicSheets(source,{showPassives=false}={}){
  const folded=folding(source,showPassives),{view:model,merged}=mergedModel(source,folded),signalNets=new Map();
  const visible=[...model.components.values()].filter(c=>!folded.has(c.ref));
  for(const c of visible)signalNets.set(c.ref,distinct(c.pins.map(p=>p.net).filter(n=>n&&netRole(model,n)==='signal')));
  const linksOf=refs=>{const members=new Map();for(const r of refs)for(const n of signalNets.get(r)){if(!members.has(n))members.set(n,[]);members.get(n).push(r);}return [...members.values()];};
  const pins=r=>model.components.get(r).pins.length,railsOf=r=>distinct(model.components.get(r).pins.map(p=>p.net).filter(n=>n&&netRole(model,n)==='power'));
  const sheets=[];
  // Remove the busiest part, then pack what falls apart back around it in balanced sheets, so a
  // driver keeps its channels instead of each channel getting a sheet of its own.
  function split(refs){
    if(refs.length<=MAX_SHEET*SLACK)return [refs];
    const hub=[...refs].sort((a,b)=>signalNets.get(b).length-signalNets.get(a).length||natural(a,b))[0],rest=refs.filter(r=>r!==hub);
    const pieces=components(rest,linksOf(rest)),shared=p=>p.filter(r=>signalNets.get(r).some(n=>signalNets.get(hub).includes(n))).length;
    const big=pieces.filter(p=>p.length>MAX_SHEET),small=pieces.filter(p=>p.length<=MAX_SHEET).sort((a,b)=>Number(!shared(b))-Number(!shared(a))||natural(a[0],b[0]));
    const total=1+small.reduce((n,p)=>n+p.length,0),target=Math.ceil(total/Math.ceil(total/(MAX_SHEET*SLACK))),bins=[[hub]];
    for(const p of small){if(bins.at(-1).length+p.length>target&&bins.at(-1).length)bins.push([]);bins.at(-1).push(...p);}
    return [...bins,...big.flatMap(split)];
  }
  const scopes=distinct(visible.map(c=>c.scope)).sort(natural);
  for(const scope of scopes){
    const refs=visible.filter(c=>c.scope===scope).map(c=>c.ref);
    if(refs.length<=MAX_SHEET){sheets.push({id:`sheet:${scope}:all`,title:scope||model.name,scope,anchor:refs[0],refs});continue;}
    const hubs=refs.filter(r=>signalNets.get(r).length>HUB),rest=refs.filter(r=>!hubs.includes(r));
    const hubSheets=hubs.map(h=>({refs:[h],hub:true})),clusters=[];let small=[];
    for(const piece of components(rest,linksOf(rest)).flatMap(split)){
      if(piece.length>SMALL){clusters.push({refs:piece});continue;}
      // Headers and single parts that only meet one hub sit on that hub's sheet.
      const reached=hubSheets.filter(s=>piece.some(r=>signalNets.get(r).some(n=>signalNets.get(s.refs[0]).includes(n))));
      if(reached.length===1&&reached[0].refs.length+piece.length<=MAX_SHEET)reached[0].refs.push(...piece);else small.push(...piece);
    }
    // Power-path parts (fuses, inductors, input connectors, LDOs) share no signal net with anything.
    // They join the sheet of the regulator they share rails with rather than "Other parts".
    const powerParts=small.filter(r=>!signalNets.get(r).length&&railsOf(r).length);
    if(powerParts.length){
      const wanted=new Set(powerParts.flatMap(railsOf)),drives=r=>model.components.get(r).pins.some(p=>wanted.has(p.net)&&p.profile.domains?.includes('power')&&p.profile.directions?.includes('output'));
      const score=s=>distinct(s.refs.flatMap(railsOf)).filter(n=>wanted.has(n)).length+(s.refs.some(drives)?10:0);
      let home=[...hubSheets,...clusters].filter(s=>s.refs.length+powerParts.length<=MAX_SHEET*SLACK&&score(s)).sort((a,b)=>score(b)-score(a))[0];
      if(!home){home={refs:[]};clusters.push(home);}
      home.refs.push(...powerParts);home.power=true;small=small.filter(r=>!powerParts.includes(r));
    }
    const other=[];for(const r of small.sort(natural)){if(!other.length||other.at(-1).refs.length>=MAX_SHEET)other.push({refs:[],other:true});other.at(-1).refs.push(r);}
    for(const s of [...hubSheets,...clusters.sort((a,b)=>b.refs.length-a.refs.length),...other]){
      const anchor=s.hub?s.refs[0]:[...s.refs].sort((a,b)=>Number(isPassive(model.components.get(a)))-Number(isPassive(model.components.get(b)))||pins(b)-pins(a)||natural(a,b))[0];
      const label=s.other?'Other parts':s.power?`Power · ${anchor.split('/').pop()}`:anchor.split('/').pop();
      sheets.push({id:`sheet:${scope}:${s.other?`other-${other.indexOf(s)}`:anchor}`,title:`${scope?scope+' · ':''}${label}`,scope,anchor,refs:s.refs});
    }
  }
  // On each sheet, rails that join a power-path part to another power-path part or a regulator are
  // drawn as wires between those parts; other ICs' supply pins keep their rail flags.
  const pathParts=new Set(visible.filter(c=>!signalNets.get(c.ref).length&&railsOf(c.ref).length).map(c=>c.ref));
  const railParts=new Set([...pathParts,...(source.rails||[]).flatMap(r=>r.sources.map(id=>source.pins.get(id)?.component).filter(Boolean))]);
  for(const s of sheets){const on=new Set(s.refs),count=new Map();s.railParts=s.refs.filter(r=>railParts.has(r));for(const r of s.railParts)for(const n of railsOf(r))count.set(n,(count.get(n)||0)+1);
    s.wired=[...count].filter(([n,k])=>k>1&&s.refs.some(r=>pathParts.has(r)&&railsOf(r).includes(n))).map(([n])=>n);
    // Wired rails run from their source (regulator output, fuse, inductor) to their loads.
    s.flow=(source.rails||[]).filter(r=>s.wired.includes(r.net)).flatMap(r=>distinct(r.sources.map(id=>source.pins.get(id)?.component).filter(c=>on.has(c))).flatMap(a=>r.loads.filter(b=>b!==a&&on.has(b)&&railParts.has(b)).map(b=>[a,b])));}
  const sheetOf=new Map();for(const s of sheets)for(const r of s.refs)sheetOf.set(r,s.id);
  for(const f of folded.values()){
    const net=[...merged].find(([,names])=>names.includes(f.net))?.[0]||f.net;
    const host=f.pin?model.pins.get(f.pin).component:model.nets.get(net)?.pins.map(p=>p.component).find(r=>sheetOf.has(r)&&!folded.has(r));
    if(host&&sheetOf.has(host))sheetOf.set(f.ref,sheetOf.get(host));
  }
  return {sheets,folded,sheetOf,view:model,merged};
}

/** Columns follow signal direction; undirected parts sit between their neighbours. */
function columns(model,refs,netsOf,flow=[]){
  const inSheet=new Set(refs),out=new Map(refs.map(r=>[r,new Set()])),neighbors=new Map(refs.map(r=>[r,new Set()])),directed=new Set();
  const members=new Map();for(const r of refs)for(const p of model.components.get(r).pins)if(netsOf.has(p.net)){if(!members.has(p.net))members.set(p.net,[]);members.get(p.net).push(p);}
  for(const pins of members.values()){
    for(const a of pins)for(const b of pins)if(a.component!==b.component){neighbors.get(a.component).add(b.component);if(outputOnly(a)&&inputOnly(b)){out.get(a.component).add(b.component);directed.add(a.component);directed.add(b.component);}}
  }
  // A series two-pin part passes direction on (driver → receiver); the part itself sits between them.
  const link=(a,b)=>{out.get(a).add(b);directed.add(a);directed.add(b);};
  for(const r of refs){const c=model.components.get(r);if(!twoPin(c))continue;const [x,y]=c.pins.map(p=>members.get(p.net)||[]);
    for(const [from,to]of [[x,y],[y,x]]){const drivers=from.filter(p=>p.component!==r&&outputOnly(p)),receivers=to.filter(p=>p.component!==r&&inputOnly(p));for(const d of drivers)for(const q of receivers)if(d.component!==q.component)link(d.component,q.component);}}
  for(const [a,b]of flow)if(out.has(a)&&out.has(b))link(a,b);
  // Drop feedback edges, then take longest paths through what remains.
  const state=new Map(),order=[];
  const visit=r=>{state.set(r,1);for(const s of out.get(r))if(!state.has(s))visit(s);else if(state.get(s)===1)out.get(r).delete(s);state.set(r,2);order.push(r);};
  for(const r of [...refs].sort(natural))if(!state.has(r))visit(r);
  const rank=new Map();for(const r of order.reverse())if(directed.has(r)){if(!rank.has(r))rank.set(r,0);for(const s of out.get(r))rank.set(s,Math.max(rank.get(s)||0,rank.get(r)+1));}
  for(const [r,v]of rank)rank.set(r,v*2);
  const pieces=components(refs,[...members.values()].map(pins=>distinct(pins.map(p=>p.component)))).sort((a,b)=>b.length-a.length||natural(a[0],b[0]));
  const estimate=r=>{const c=model.components.get(r);return twoPin(c)?72:HEAD+FOOT+90+Math.ceil(c.pins.filter(p=>p.net&&netsOf.has(p.net)).length/2)*PIN;};
  let offset=0,bandHeight=0,bandSpan=0;
  for(const piece of pieces){
    // Parts without pin directions: breadth-first columns from the best-connected part.
    if(!piece.some(r=>rank.has(r))){const root=[...piece].sort((a,b)=>neighbors.get(b).size-neighbors.get(a).size||natural(a,b))[0],queue=[root];rank.set(root,0);for(let i=0;i<queue.length;i++)for(const n of neighbors.get(queue[i]))if(!rank.has(n)){rank.set(n,rank.get(queue[i])+2);queue.push(n);}}
    const loose=piece.filter(r=>!directed.has(r)&&rank.get(r)===undefined);
    for(let pass=0;pass<6;pass++)for(const r of loose){const known=[...neighbors.get(r)].filter(n=>rank.has(n)&&n!==r).map(n=>rank.get(n));if(known.length){let v=Math.round(mean(known));if(v%2===0&&known.every(k=>k===v))v-=1;rank.set(r,v);}}
    for(const r of piece)if(!rank.has(r))rank.set(r,0);
    const low=Math.min(...piece.map(r=>rank.get(r))),span=Math.max(...piece.map(r=>rank.get(r)))-low;
    const heights=new Map();for(const r of piece){const k=rank.get(r);heights.set(k,(heights.get(k)||0)+estimate(r));}
    const height=Math.max(...heights.values());
    // Unconnected pieces pack into bands so a sheet grows sideways, not into one column.
    if(bandHeight&&bandHeight+height>BAND){offset+=bandSpan+2;bandHeight=0;bandSpan=0;}
    for(const r of piece)rank.set(r,rank.get(r)-low+offset);bandHeight+=height;bandSpan=Math.max(bandSpan,span);
  }
  const values=distinct([...rank.values()]).sort((a,b)=>a-b),column=new Map(refs.map(r=>[r,values.indexOf(rank.get(r))]));
  const layers=values.map((_,i)=>refs.filter(r=>column.get(r)===i).sort(natural)),position=new Map();
  const index=()=>{for(const layer of layers)layer.forEach((r,i)=>position.set(r,i));};index();
  const reorder=()=>{for(let pass=0;pass<6;pass++){for(const layer of pass%2?[...layers].reverse():layers){const score=r=>{const ns=[...neighbors.get(r)].filter(n=>inSheet.has(n));return ns.length?mean(ns.map(n=>position.get(n))):position.get(r);};layer.sort((a,b)=>score(a)-score(b)||natural(a,b));}index();}};
  reorder();
  // A column taller than a band wraps into side-by-side columns around its best-connected part,
  // whose neighbours take the nearest columns so they can still be wired to it.
  const heightOf=rs=>rs.reduce((sum,r)=>sum+estimate(r)+30,0);
  if(layers.some(layer=>heightOf(layer)>WRAP)){
    const wrapped=[];
    for(const layer of layers){
      if(heightOf(layer)<=WRAP){wrapped.push(layer);continue;}
      // The hub may sit in its own column next to its satellites; it moves into the middle.
      const links=r=>[...neighbors.get(r)].filter(n=>layer.includes(n)).length,hub=[...refs].sort((a,b)=>links(b)-links(a)||natural(a,b))[0];
      if(!layer.includes(hub)){for(const other of [...layers,...wrapped]){const k=other.indexOf(hub);if(k>=0)other.splice(k,1);}layer.push(hub);}
      const near=r=>neighbors.get(hub).has(r)?1:0,sides=[[],[]];
      for(const r of layer.filter(r=>r!==hub).sort((a,b)=>near(b)-near(a)||links(b)-links(a)||position.get(a)-position.get(b))){
        const side=sides[heightOf(sides[0].flat())<=heightOf(sides[1].flat())?0:1];
        let col=side.find(c=>heightOf(c)+estimate(r)+30<=WRAP);if(!col){col=[];side.push(col);}col.push(r);
      }
      wrapped.push(...sides[0].reverse(),[hub],...sides[1]);
    }
    layers.splice(0,layers.length,...wrapped.filter(layer=>layer.length));
    for(const [i,layer]of layers.entries())for(const r of layer)column.set(r,i);
    index();reorder();
  }
  // Small parts that share a signal net (an LED and its resistor, a crystal and its load
  // capacitors) stay together: the members next to their IC keep one column beside it, each
  // further hop steps one column outward, and every member lines up with the part it hangs off.
  // Parts on a power flow (fuses, inductors) keep their flow columns instead of grouping.
  const onFlow=new Set(flow.flat()),isSmall=r=>model.components.get(r).pins.length<=SMALL_PINS&&!onFlow.has(r),parentOf=new Map();
  const groups=components(refs.filter(isSmall),[...members.values()].map(pins=>distinct(pins.map(p=>p.component)).filter(isSmall))).filter(g=>g.length>1);
  const target=new Map();
  for(const g of groups){
    const inGroup=new Set(g),count=new Map();
    for(const r of g)for(const n of neighbors.get(r))if(!inGroup.has(n)&&!isSmall(n))count.set(n,(count.get(n)||0)+1);
    const anchor=[...count].sort((a,b)=>b[1]-a[1]||natural(a[0],b[0]))[0]?.[0];
    const queue=anchor?g.filter(r=>neighbors.get(r).has(anchor)):[];if(!queue.length)queue.push([...g].sort((a,b)=>neighbors.get(b).size-neighbors.get(a).size||natural(a,b))[0]);
    const depth=new Map(queue.map(r=>[r,1]));if(anchor)for(const r of queue)parentOf.set(r,anchor);
    for(let i=0;i<queue.length;i++)for(const n of [...neighbors.get(queue[i])].sort(natural))if(inGroup.has(n)&&!depth.has(n)){depth.set(n,depth.get(queue[i])+1);parentOf.set(n,queue[i]);queue.push(n);}
    for(const r of g)if(!depth.has(r))depth.set(r,1);
    const first=g.filter(r=>depth.get(r)===1),at=anchor?column.get(anchor):null;let home=Math.round(mean(first.map(r=>column.get(r))));
    const side=at===null||home>at||home===at&&mean(first.map(r=>column.get(r)))>=at?1:-1;if(at!==null&&home===at)home=at+side;
    for(const r of g)target.set(r,home+side*(Math.min(depth.get(r),6)-1));
  }
  if(target.size){
    const shift=Math.max(0,-Math.min(...target.values()));
    for(const r of refs)column.set(r,(target.has(r)?target.get(r):column.get(r))+shift);
    const used=distinct([...column.values()]).sort((a,b)=>a-b);
    const rebuilt=used.map(c=>refs.filter(r=>column.get(r)===c).sort((a,b)=>(position.get(a)??0)-(position.get(b)??0)));
    layers.splice(0,layers.length,...rebuilt);for(const [i,layer]of layers.entries())for(const r of layer)column.set(r,i);
    index();reorder();
    // Keep each group in one block within a column.
    const groupOf=new Map(groups.flatMap((g,i)=>g.map(r=>[r,i])));
    for(const layer of layers){const out=[],done=new Set();for(const r of layer){if(done.has(r))continue;const k=groupOf.get(r);const block=k===undefined?[r]:layer.filter(x=>groupOf.get(x)===k);for(const x of block){done.add(x);out.push(x);}}layer.splice(0,layer.length,...out);}
    index();
  }
  return {column,layers,members,parentOf};
}

/** Orders wire lanes in one column gap to avoid crossings; sets each net's lane, returns the lane count.
 * Each net has its span (lo, hi) and the heights of its pins on the west and east side of the gap. */
export function orderLanes(list){
  const inside=(y,w)=>y>w.lo&&y<w.hi,overlap=(a,b)=>!(a.hi<b.lo-8||b.hi<a.lo-8);
  const cost=(b,a)=>overlap(a,b)?a.west.filter(y=>inside(y,b)).length+b.east.filter(y=>inside(y,a)).length:0;
  let order=list;
  for(let pass=0;pass<6;pass++){
    let moved=false;
    for(const w of [...order]){
      const rest=order.filter(x=>x!==w),here=order.indexOf(w);
      let c=rest.reduce((sum,x)=>sum+cost(w,x),0),best=c,at=0;
      for(let k=0;k<rest.length;k++){c+=cost(rest[k],w)-cost(w,rest[k]);if(c<best||c===best&&k+1===here){best=c;at=k+1;}}
      if(at!==here){rest.splice(at,0,w);order=rest;moved=true;}
    }
    if(!moved)break;
  }
  // Each net takes the first lane right of every overlapping net before it, so lanes stay shared.
  for(const [i,w]of order.entries())w.lane=Math.max(0,...order.slice(0,i).filter(x=>overlap(x,w)).map(x=>x.lane+1));
  return Math.max(0,...order.map(w=>w.lane+1));
}
export function layoutSheet(source,sheet,{folded,view}){
  const model=view||source,refs=sheet.refs,inSheet=new Set(refs),netsOf=new Set(),railWires=new Set(sheet.wired||[]),railParts=new Set(sheet.railParts||[]);
  const roleOf=p=>p.net&&railWires.has(p.net)&&railParts.has(p.component)?'signal':pinRole(model,p);
  for(const r of refs)for(const p of model.components.get(r).pins)if(p.net&&roleOf(p)==='signal')netsOf.add(p.net);
  const {column,layers,members,parentOf}=columns(model,refs,netsOf,sheet.flow);
  const symbols=new Map(),pinAt=new Map(),ties=new Map();
  const strapped=p=>{const d=p.profile.domains||[];return d.length>0&&!d.includes('power')&&!d.includes('ground');};
  const neighborColumns=p=>(members.get(p.net)||[]).filter(q=>q.component!==p.component).map(q=>column.get(q.component));
  for(const r of refs){
    const c=model.components.get(r),two=twoPin(c),col=column.get(r),left=[],right=[],top=new Map(),bottom=new Map();let nc=0;
    for(const p of c.pins){
      const role=roleOf(p);
      if(role==='nc'){nc++;continue;}
      // Only supply pins become rail flags. A logic pin strapped to a rail (OE_N, DIR, CS, EN)
      // stays on the symbol side so the strap can be reviewed.
      if((role==='power'||role==='ground')&&!two&&!/^(connector|passive)\./.test(c.partDefinition.category||'')&&strapped(p))ties.set(p.id,role);
      else if(role==='power'||role==='ground'){const groups=role==='power'?top:bottom;if(!groups.has(p.net))groups.set(p.net,[]);groups.get(p.net).push(p);continue;}
      const cols=neighborColumns(p),avg=cols.length?mean(cols):col;
      const side=cols.length?(avg<col?left:avg>col?right:left):outputOnly(p)?right:inputOnly(p)?left:left.length<=right.length?left:right;side.push(p);
    }
    if(two){
      // Two-pin parts read left to right; with a rail flag the free side carries the text.
      const both=[...left,...right].sort((a,b)=>mean(neighborColumns(a).concat(col))-mean(neighborColumns(b).concat(col)));
      left.length=0;right.length=0;if(both.length===2){left.push(both[0]);right.push(both[1]);}
      else if(both.length===1&&mean(neighborColumns(both[0]).concat(col))>col)right.push(both[0]);else left.push(...both);
    }
    for(const side of [left,right])side.sort((a,b)=>natural(a.number??a.name,b.number??b.name));
    const shortName=c.part.split('.').pop(),value=c.value?compactQuantity(c.value):'',title=r.split('/').pop(),inline=two&&right.length===1;
    const text=Math.ceil(Math.max(title.length,(value||shortName).length)*6.4);
    const w=two?TWO:Math.max(130,(Math.max(0,...left.map(p=>p.name.length))+Math.max(0,...right.map(p=>p.name.length)))*CHAR+44,Math.max(top.size,bottom.size)*72,Math.max(title.length,shortName.length)*CHAR+24);
    const h=two?16:HEAD+Math.max(1,left.length,right.length)*PIN+FOOT;
    symbols.set(r,{ref:r,part:c.part,title,subtitle:two?value||shortName:shortName,two,inline,col,w,h,extent:two?(inline?Math.max(TWO,text):TWO+8+text):w,left,right,top:[...top].map(([net,pins])=>({net,pins})),bottom:[...bottom].map(([net,pins])=>({net,pins})),nc});
  }
  // Vertical stacking per column, leaving room for rail flags and ground symbols.
  // A grouped part sits level with the part it hangs off when its column has room; two passes
  // let parts in earlier columns align to parents placed later.
  const want=r=>{const s=symbols.get(r),parent=symbols.get(parentOf.get(r));return parent?.y===undefined?s.y:Math.round(parent.y+parent.h/2-s.h/2);};
  const colY=[],stack=sorted=>{for(const [i,layer]of layers.entries()){if(sorted){const slots=layer.flatMap((r,k)=>parentOf.has(r)&&parentOf.has(parentOf.get(r))&&symbols.get(parentOf.get(r))?.y!==undefined?[k]:[]),moved=slots.map(k=>layer[k]).sort((a,b)=>want(a)-want(b));slots.forEach((k,j)=>{layer[k]=moved[j];});}let y=24;for(const r of layer){const s=symbols.get(r),parent=symbols.get(parentOf.get(r));y+=s.top.length?46:s.two?18:0;s.y=Math.max(y,parent?.y===undefined?0:Math.round(parent.y+parent.h/2-s.h/2));y=s.y+s.h+(s.bottom.length?46:s.two?20:0)+30;}colY[i]=y;}};
  stack(false);stack(true);stack(true);
  const pinY=(s,side,i)=>s.two?s.y+s.h/2:s.y+HEAD+PIN/2+i*PIN;
  // Reorder side pins by where their nets go, then fix pin rows.
  for(const s of symbols.values())for(const side of ['left','right'])s[side].forEach((p,i)=>pinAt.set(p.id,{s,side,y:pinY(s,side,i)}));
  for(const s of symbols.values())if(!s.two)for(const side of ['left','right']){
    const target=p=>{const ys=(members.get(p.net)||[]).filter(q=>q.component!==s.ref&&pinAt.has(q.id)).map(q=>pinAt.get(q.id).y);return ys.length?mean(ys):Infinity;};
    s[side].sort((a,b)=>target(a)-target(b)||natural(a.number??a.name,b.number??b.name));s[side].forEach((p,i)=>pinAt.set(p.id,{s,side,y:pinY(s,side,i)}));
  }
  // A net becomes a wire when every pin on this sheet faces the same column gap.
  const gapOf=p=>{const a=pinAt.get(p.id);return a.side==='left'?a.s.col-1:a.s.col;};
  const wired=new Map(),labelled=[];
  for(const net of [...netsOf].sort(natural)){
    const pins=(members.get(net)||[]).filter(p=>pinAt.has(p.id)),gaps=distinct(pins.map(gapOf)),offsheet=model.nets.get(net).pins.some(p=>!inSheet.has(p.component)&&!folded.has(p.component));
    if(pins.length>=2&&gaps.length===1)wired.set(net,{net,gap:gaps[0],pins,offsheet,ys:pins.map(p=>pinAt.get(p.id).y)});
    else if(railWires.has(net)){
      // A rail wires its busiest column gap; pins facing elsewhere carry its label.
      const gap=gaps.map(g=>[g,pins.filter(p=>gapOf(p)===g)]).sort((a,b)=>b[1].length-a[1].length||a[0]-b[0])[0],main=gap[1].length>=2?gap[1]:[];
      if(main.length)wired.set(net,{net,gap:gap[0],pins:main,offsheet,ys:main.map(p=>pinAt.get(p.id).y)});
      for(const p of pins)if(!main.includes(p))labelled.push({net,pin:p,offsheet});
    }
    else for(const p of pins)labelled.push({net,pin:p,offsheet});
  }
  for(const s of symbols.values())for(const p of [...s.left,...s.right])if(ties.has(p.id))labelled.push({net:p.net,pin:p,offsheet:false,tie:ties.get(p.id)});
  const lanes=new Map();
  // Lanes in a gap are ordered to avoid crossings. A pin's horizontal run crosses another net's
  // lane when that lane lies between the pin and its own lane and spans the pin's height, so the
  // cost of putting net b left of net a is a's west pins inside b plus b's east pins inside a.
  for(const g of distinct([...wired.values()].map(w=>w.gap))){
    const list=[...wired.values()].filter(w=>w.gap===g).sort((a,b)=>Math.min(...a.ys)-Math.min(...b.ys));
    for(const w of list){w.lo=Math.min(...w.ys);w.hi=Math.max(...w.ys);w.west=[];w.east=[];for(const p of w.pins)(pinAt.get(p.id).side==='right'?w.west:w.east).push(pinAt.get(p.id).y);}
    lanes.set(g,orderLanes(list));
  }
  const labelWidth=net=>Math.min(26,net.length)*6.4+14;
  const notesFor=new Map();
  const drawnNet=n=>model.nets.has(n)?n:[...model.nets.values()].find(x=>x.merged?.includes(n))?.name;
  for(const f of folded.values())if(f.kind!=='support')for(const n of distinct((f.nets||[f.net]).map(drawnNet).filter(Boolean))){if(!notesFor.has(n))notesFor.set(n,[]);notesFor.get(n).push(f);}
  const colWidth=layers.map(layer=>Math.max(0,...layer.map(r=>symbols.get(r).extent)));
  const sideSpace=(col,side)=>Math.max(0,...labelled.filter(l=>{const a=pinAt.get(l.pin.id);return a.s.col===col&&a.side===side;}).map(l=>labelWidth(l.net)),...[...notesFor.keys()].flatMap(net=>(members.get(net)||[]).filter(p=>pinAt.has(p.id)&&pinAt.get(p.id).s.col===col&&pinAt.get(p.id).side===side)).map(()=>70));
  const gapWidth=g=>STUB*2+(g>=0?sideSpace(g,'right'):0)+(g<layers.length-1?sideSpace(g+1,'left'):0)+(lanes.get(g)||0)*LANE+(lanes.get(g)?24:12);
  const colX=[];let x=gapWidth(-1);for(let i=0;i<layers.length;i++){colX[i]=x;x+=colWidth[i]+gapWidth(i);}
  const laneX=(g,lane)=>{const start=g<0?0:colX[g]+colWidth[g],before=STUB+(g>=0?sideSpace(g,'right'):0);return start+before+12+lane*LANE;};
  for(const s of symbols.values())s.x=colX[s.col];
  // Geometry.
  const out={id:sheet.id,title:sheet.title,symbols:[],wires:[],labels:[],notes:[],width:x,height:Math.max(160,...colY)};
  const pinPoint=p=>{const a=pinAt.get(p.id);return {x:a.side==='left'?a.s.x:a.s.x+a.s.w,y:a.y,dir:a.side==='left'?-1:1};};
  for(const s of symbols.values()){
    const sym={ref:s.ref,title:s.title,subtitle:s.subtitle,part:s.part,two:s.two,inline:s.inline,x:s.x,y:s.y,w:s.w,h:s.h,nc:s.nc,pins:[],top:[],bottom:[]};
    for(const side of ['left','right'])for(const p of s[side]){const pt=pinPoint(p);sym.pins.push({id:p.id,name:p.name,number:p.number,net:p.net,raw:p.rawNet||p.net,side,x:pt.x,y:pt.y,end:pt.x+pt.dir*STUB});}
    const spread=(groups,y,dir)=>groups.map((g,i)=>{const split=s.two&&groups.length===2,gx=split?s.x+(i?s.w-4:4):s.x+s.w*(i+1)/(groups.length+1);const badges=[...folded.values()].filter(f=>f.kind==='support'&&f.pin&&model.pins.get(f.pin).component===s.ref&&f.net===g.net);return {net:g.net,pins:g.pins.map(p=>p.id),names:g.pins.map(p=>p.name),x:gx,y,end:y+dir*16,anchor:split?(i?'start':'end'):'middle',badges:badges.map(f=>f.ref)};});
    sym.top=spread(s.top,s.y,-1);sym.bottom=spread(s.bottom,s.y+s.h,1);
    out.symbols.push(sym);
  }
  for(const w of wired.values()){
    const lx=laneX(w.gap,w.lane),pts=w.pins.map(p=>{const pt=pinPoint(p);return {pin:p.id,x:pt.x,y:pt.y,end:pt.x+pt.dir*STUB};});
    const lo=Math.min(...pts.map(p=>p.y)),hi=Math.max(...pts.map(p=>p.y)),segments=[[lx,lo,lx,hi],...pts.map(p=>[p.x,p.y,lx,p.y])];
    const dots=pts.length>2?pts.filter(p=>p.y>lo&&p.y<hi).map(p=>[lx,p.y]):[];
    const top=pts.find(p=>p.y===lo);
    out.wires.push({net:w.net,pins:pts.map(p=>p.pin),segments,dots,offsheet:w.offsheet?{x:Math.min(top.end,lx)+(top.end<lx?2:-2),y:lo,anchor:top.end<lx?'start':'end'}:null});
  }
  for(const l of labelled){const pt=pinPoint(l.pin);out.labels.push({net:l.net,pin:l.pin.id,x:pt.x+pt.dir*STUB,y:pt.y,anchor:pt.dir<0?'end':'start',x0:pt.x,offsheet:l.offsheet,...(l.tie?{tie:l.tie}:{})});}
  const mark=f=>{const v=compactQuantity(model.components.get(f.ref).value);return f.kind==='pullup'?`↑${v}`:f.kind==='pulldown'?`↓${v}`:f.kind==='protect'?'ESD':`⟷${v||f.ref.split('/').pop()}`;};
  const describe=f=>{const c=model.components.get(f.ref),v=c.value?quantity(c.value):c.part.split('.').pop();return f.kind==='protect'?`${f.ref}: ESD/TVS protection on ${f.nets.join(', ')}`:f.kind==='series'?`${f.ref}: series ${v} between ${f.nets.join(' and ')}`:`${f.ref}: ${f.kind==='pullup'?'pull-up':'pull-down'} ${v} to ${f.rail}`;};
  for(const [net,fs]of notesFor)for(const p of (members.get(net)||[]).filter(p=>pinAt.has(p.id)&&!isPassive(model.components.get(p.component)))){
    // A series link is marked on its far side only: the pins whose own net is not the drawn name.
    const here=fs.filter(f=>f.kind!=='series'||(p.rawNet&&p.rawNet!==net&&f.nets.includes(p.rawNet)));if(!here.length)continue;
    const pt=pinPoint(p);
    out.notes.push({net,refs:here.map(f=>f.ref),text:here.map(mark).join(' '),x:pt.x+pt.dir*(STUB+2),y:pt.y+13,anchor:pt.dir<0?'end':'start',title:here.map(describe).join('\n')});
  }
  out.width=Math.max(out.width,...out.labels.map(l=>l.anchor==='start'?l.x+labelWidth(l.net):0))+24;
  return out;
}
