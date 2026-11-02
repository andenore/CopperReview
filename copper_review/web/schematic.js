/* Generated schematic sheets from the electrical IR. Nothing here is authored drawing
 * intent: power and ground pins become flags, support passives fold into badges, and a
 * net is drawn as a wire only where it cannot cross a symbol; otherwise it gets labels. */
import {isPassive,quantity} from './electrical-model.js';

const PIN=20,HEAD=40,FOOT=16,STUB=18,LANE=10,CHAR=7,TWO=48,HUB=20,MAX_SHEET=36,SMALL=3,BAND=1100;
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
  const only=(p,domain,other)=>p.profile.domains?.includes(domain)&&!p.profile.domains.includes(other);
  const ground=n.pins.filter(p=>only(p,'ground','power')).length,power=n.pins.filter(p=>only(p,'power','ground')).length;
  return ground&&ground>=power?'ground':power?'power':'signal';
}
const pinRole=(model,p)=>p.net?netRole(model,p.net):'nc';
const twoPin=c=>c.pins.length===2;

/** Passives folded out of the drawing. Every fold stays listed and selectable. */
function folding(model,showPassives){
  const folded=new Map();if(showPassives)return folded;
  for(const c of model.components.values()){
    if(!isPassive(c))continue;
    const nets=c.pins.map(p=>p.net);
    if(c.properties?.role==='decoupling'||c.properties?.decouples||nets.some(Boolean)&&nets.filter(Boolean).every(n=>netRole(model,n)!=='signal')){
      const target=typeof c.properties?.decouples==='string'?scoped(c.scope,c.properties.decouples):null,rail=c.pins.map(p=>p.net).find(n=>n&&netRole(model,n)!=='ground')||c.pins.find(p=>p.net)?.net||null;
      folded.set(c.ref,{kind:'support',ref:c.ref,pin:model.pins.has(target)?target:null,net:rail});continue;
    }
    // Pull resistors only: shunts, terminations and series resistors (< 1 kΩ) stay drawn.
    if(!twoPin(c)||!nets.every(Boolean)||!/resistor/.test(c.partDefinition.category||'')||!(Number(c.value?.base_value)>=1000))continue;
    const fixed=nets.filter(n=>netRole(model,n)!=='signal'),signal=nets.filter(n=>netRole(model,n)==='signal');
    if(fixed.length!==1||signal.length!==1)continue;
    // Only plain pull resistors: a divider or filter node keeps its passives visible.
    const others=model.nets.get(signal[0]).pins.filter(p=>p.component!==c.ref);
    if(others.length&&others.every(p=>!isPassive(model.components.get(p.component))))folded.set(c.ref,{kind:netRole(model,fixed[0])==='ground'?'pulldown':'pullup',ref:c.ref,net:signal[0],rail:fixed[0]});
  }
  return folded;
}

function components(refs,linked){
  const parent=new Map(refs.map(r=>[r,r])),find=r=>{while(parent.get(r)!==r){parent.set(r,parent.get(parent.get(r)));r=parent.get(r);}return r;};
  for(const group of linked)for(const r of group.slice(1))parent.set(find(r),find(group[0]));
  const out=new Map();for(const r of refs){const k=find(r);if(!out.has(k))out.set(k,[]);out.get(k).push(r);}return [...out.values()];
}

/** Split the board into sheets: module scopes first, then signal connectivity. */
export function schematicSheets(model,{showPassives=false}={}){
  const folded=folding(model,showPassives),signalNets=new Map();
  const visible=[...model.components.values()].filter(c=>!folded.has(c.ref));
  for(const c of visible)signalNets.set(c.ref,distinct(c.pins.map(p=>p.net).filter(n=>n&&netRole(model,n)==='signal')));
  const linksOf=refs=>{const members=new Map();for(const r of refs)for(const n of signalNets.get(r)){if(!members.has(n))members.set(n,[]);members.get(n).push(r);}return [...members.values()];};
  const pins=r=>model.components.get(r).pins.length;
  const sheets=[];
  function split(refs){
    if(refs.length<=MAX_SHEET)return [refs];
    const hub=[...refs].sort((a,b)=>signalNets.get(b).length-signalNets.get(a).length||natural(a,b))[0],rest=refs.filter(r=>r!==hub);
    const pieces=components(rest,linksOf(rest)),shared=p=>p.filter(r=>signalNets.get(r).some(n=>signalNets.get(hub).includes(n))).length;
    const home=pieces.filter(p=>p.length<MAX_SHEET).sort((a,b)=>shared(b)-shared(a))[0];
    if(home&&shared(home))home.push(hub);else pieces.push([hub]);
    return pieces.flatMap(split);
  }
  const scopes=distinct(visible.map(c=>c.scope)).sort(natural);
  for(const scope of scopes){
    const refs=visible.filter(c=>c.scope===scope).map(c=>c.ref);
    if(refs.length<=MAX_SHEET){sheets.push({id:`sheet:${scope}:all`,title:scope||model.name,scope,anchor:refs[0],refs});continue;}
    const hubs=refs.filter(r=>signalNets.get(r).length>HUB),rest=refs.filter(r=>!hubs.includes(r));
    const hubSheets=hubs.map(h=>({refs:[h],hub:true})),small=[],clusters=[];
    for(const piece of components(rest,linksOf(rest)).flatMap(split)){
      if(piece.length>SMALL){clusters.push({refs:piece});continue;}
      // Headers and single parts that only meet one hub sit on that hub's sheet.
      const reached=hubSheets.filter(s=>piece.some(r=>signalNets.get(r).some(n=>signalNets.get(s.refs[0]).includes(n))));
      if(reached.length===1&&reached[0].refs.length+piece.length<=MAX_SHEET)reached[0].refs.push(...piece);else small.push(...piece);
    }
    const other=[];for(const r of small.sort(natural)){if(!other.length||other.at(-1).refs.length>=MAX_SHEET)other.push({refs:[],other:true});other.at(-1).refs.push(r);}
    for(const s of [...hubSheets,...clusters.sort((a,b)=>b.refs.length-a.refs.length),...other]){
      const anchor=s.hub?s.refs[0]:[...s.refs].sort((a,b)=>Number(isPassive(model.components.get(a)))-Number(isPassive(model.components.get(b)))||pins(b)-pins(a)||natural(a,b))[0];
      const label=s.other?'Other parts':anchor.split('/').pop();
      sheets.push({id:`sheet:${scope}:${s.other?`other-${other.indexOf(s)}`:anchor}`,title:`${scope?scope+' · ':''}${label}`,scope,anchor,refs:s.refs});
    }
  }
  const sheetOf=new Map();for(const s of sheets)for(const r of s.refs)sheetOf.set(r,s.id);
  for(const f of folded.values()){
    const host=f.pin?model.pins.get(f.pin).component:model.nets.get(f.net)?.pins.map(p=>p.component).find(r=>sheetOf.has(r)&&!folded.has(r));
    if(host&&sheetOf.has(host))sheetOf.set(f.ref,sheetOf.get(host));
  }
  return {sheets,folded,sheetOf};
}

/** Columns follow signal direction; undirected parts sit between their neighbours. */
function columns(model,refs,netsOf){
  const inSheet=new Set(refs),out=new Map(refs.map(r=>[r,new Set()])),neighbors=new Map(refs.map(r=>[r,new Set()])),directed=new Set();
  const members=new Map();for(const r of refs)for(const p of model.components.get(r).pins)if(netsOf.has(p.net)){if(!members.has(p.net))members.set(p.net,[]);members.get(p.net).push(p);}
  for(const pins of members.values()){
    for(const a of pins)for(const b of pins)if(a.component!==b.component){neighbors.get(a.component).add(b.component);if(outputOnly(a)&&inputOnly(b)){out.get(a.component).add(b.component);directed.add(a.component);directed.add(b.component);}}
  }
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
  for(let pass=0;pass<6;pass++){for(const layer of pass%2?[...layers].reverse():layers){const score=r=>{const ns=[...neighbors.get(r)].filter(n=>inSheet.has(n));return ns.length?mean(ns.map(n=>position.get(n))):position.get(r);};layer.sort((a,b)=>score(a)-score(b)||natural(a,b));}index();}
  return {column,layers,members};
}

export function layoutSheet(model,sheet,{folded}){
  const refs=sheet.refs,inSheet=new Set(refs),netsOf=new Set();
  for(const r of refs)for(const p of model.components.get(r).pins)if(p.net&&pinRole(model,p)==='signal')netsOf.add(p.net);
  const {column,layers,members}=columns(model,refs,netsOf);
  const symbols=new Map(),pinAt=new Map();
  const neighborColumns=p=>(members.get(p.net)||[]).filter(q=>q.component!==p.component).map(q=>column.get(q.component));
  for(const r of refs){
    const c=model.components.get(r),two=twoPin(c),col=column.get(r),left=[],right=[],top=new Map(),bottom=new Map();let nc=0;
    for(const p of c.pins){
      const role=pinRole(model,p);
      if(role==='nc'){nc++;continue;}
      if(role==='power'||role==='ground'){const groups=role==='power'?top:bottom;if(!groups.has(p.net))groups.set(p.net,[]);groups.get(p.net).push(p);continue;}
      const cols=neighborColumns(p),avg=cols.length?mean(cols):col;
      const side=cols.length?(avg<col?left:avg>col?right:left):outputOnly(p)?right:inputOnly(p)?left:left.length<=right.length?left:right;side.push(p);
    }
    if(two){
      // Two-pin parts read left to right; with a rail flag the free side carries the text.
      const both=[...left,...right].sort((a,b)=>mean(neighborColumns(a).concat(col))-mean(neighborColumns(b).concat(col)));
      left.length=0;right.length=0;if(both.length===2){left.push(both[0]);right.push(both[1]);}else left.push(...both);
    }
    for(const side of [left,right])side.sort((a,b)=>natural(a.number??a.name,b.number??b.name));
    const shortName=c.part.split('.').pop(),value=c.value?quantity(c.value):'',title=r.split('/').pop(),inline=two&&right.length===1;
    const text=Math.ceil(Math.max(title.length,(value||shortName).length)*6.4);
    const w=two?TWO:Math.max(130,(Math.max(0,...left.map(p=>p.name.length))+Math.max(0,...right.map(p=>p.name.length)))*CHAR+44,Math.max(top.size,bottom.size)*72,Math.max(title.length,shortName.length)*CHAR+24);
    const h=two?16:HEAD+Math.max(1,left.length,right.length)*PIN+FOOT;
    symbols.set(r,{ref:r,part:c.part,title,subtitle:two?value||shortName:shortName,two,inline,col,w,h,extent:two?(inline?Math.max(TWO,text):TWO+8+text):w,left,right,top:[...top].map(([net,pins])=>({net,pins})),bottom:[...bottom].map(([net,pins])=>({net,pins})),nc});
  }
  // Vertical stacking per column, leaving room for rail flags and ground symbols.
  const colY=[];for(const [i,layer]of layers.entries()){let y=24;for(const r of layer){const s=symbols.get(r);y+=s.top.length?46:s.two?18:0;s.y=y;y+=s.h+(s.bottom.length?46:s.two?20:0)+30;}colY[i]=y;}
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
    else for(const p of pins)labelled.push({net,pin:p,offsheet});
  }
  const lanes=new Map();
  for(const g of distinct([...wired.values()].map(w=>w.gap))){
    const list=[...wired.values()].filter(w=>w.gap===g).sort((a,b)=>Math.min(...a.ys)-Math.min(...b.ys)),ends=[];
    for(const w of list){const lo=Math.min(...w.ys),hi=Math.max(...w.ys);let lane=ends.findIndex(e=>e<lo-8);if(lane<0){lane=ends.length;ends.push(hi);}else ends[lane]=hi;w.lane=lane;}
    lanes.set(g,ends.length);
  }
  const labelWidth=net=>Math.min(26,net.length)*6.4+14;
  const notesFor=new Map();
  for(const f of folded.values())if(f.kind!=='support'){if(!notesFor.has(f.net))notesFor.set(f.net,[]);notesFor.get(f.net).push(f);}
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
    for(const side of ['left','right'])for(const p of s[side]){const pt=pinPoint(p);sym.pins.push({id:p.id,name:p.name,number:p.number,net:p.net,side,x:pt.x,y:pt.y,end:pt.x+pt.dir*STUB});}
    const spread=(groups,y,dir)=>groups.map((g,i)=>{const split=s.two&&groups.length===2,gx=split?s.x+(i?s.w-4:4):s.x+s.w*(i+1)/(groups.length+1);const badges=[...folded.values()].filter(f=>f.kind==='support'&&f.pin&&model.pins.get(f.pin).component===s.ref&&f.net===g.net);return {net:g.net,pins:g.pins.map(p=>p.id),names:g.pins.map(p=>p.name),x:gx,y,end:y+dir*16,anchor:split?(i?'start':'end'):'middle',badges:badges.map(f=>f.ref)};});
    sym.top=spread(s.top,s.y,-1);sym.bottom=spread(s.bottom,s.y+s.h,1);
    out.symbols.push(sym);
  }
  for(const w of wired.values()){
    const lx=laneX(w.gap,w.lane),pts=w.pins.map(p=>{const pt=pinPoint(p);return {pin:p.id,x:pt.x,y:pt.y,end:pt.x+pt.dir*STUB};});
    const lo=Math.min(...pts.map(p=>p.y)),hi=Math.max(...pts.map(p=>p.y)),segments=[[lx,lo,lx,hi],...pts.map(p=>[p.x,p.y,lx,p.y])];
    const dots=pts.length>2?pts.filter(p=>p.y>lo&&p.y<hi).map(p=>[lx,p.y]):[];
    const top=pts.find(p=>p.y===lo);
    out.wires.push({net:w.net,segments,dots,offsheet:w.offsheet?{x:Math.min(top.end,lx)+(top.end<lx?2:-2),y:lo,anchor:top.end<lx?'start':'end'}:null});
  }
  for(const l of labelled){const pt=pinPoint(l.pin);out.labels.push({net:l.net,pin:l.pin.id,x:pt.x+pt.dir*STUB,y:pt.y,anchor:pt.dir<0?'end':'start',x0:pt.x,offsheet:l.offsheet});}
  for(const [net,fs]of notesFor)for(const p of (members.get(net)||[]).filter(p=>pinAt.has(p.id)&&!isPassive(model.components.get(p.component)))){
    const pt=pinPoint(p);const text=fs.map(f=>`${f.kind==='pullup'?'↑':'↓'}${quantity(model.components.get(f.ref).value)}`).join(' ');
    out.notes.push({net,refs:fs.map(f=>f.ref),text,x:pt.x+pt.dir*(STUB+2),y:pt.y+13,anchor:pt.dir<0?'end':'start',title:fs.map(f=>`${f.ref}: ${f.kind==='pullup'?'pull-up':'pull-down'} ${quantity(model.components.get(f.ref).value)} to ${f.rail}`).join('\n')});
  }
  out.width=Math.max(out.width,...out.labels.map(l=>l.anchor==='start'?l.x+labelWidth(l.net):0))+24;
  return out;
}
