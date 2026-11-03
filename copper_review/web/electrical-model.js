/* CopperScript public electrical IR adapter. No compiler or layout dependency. */
import {engineeringText} from './core.js';
export const IR_SCHEMA='copperscript-ir/v0.1';
export const ELECTRICAL_SCHEMA='copper-review-electrical/v1';
export const quantity=q=>q?`${engineeringText(q.value)} ${q.unit}`:'Unspecified';
export const isPassive=c=>/^passive\./.test(c?.partDefinition?.category||'');
export function isSupportPassive(model,c){
  if(!isPassive(c))return false;
  if(c.properties?.role==='decoupling'||c.properties?.decouples)return true;
  const nets=c.pins.map(p=>p.net).filter(Boolean);
  return nets.length>0&&nets.every(n=>model.supplyNets.has(n)||model.nets.get(n).pins.some(p=>p.profile.domains?.includes('ground')));
}
export function compactCircuit(model,circuit,showPassives=false,selection=null){
  const explicit=selection?.kind==='component'?selection.id:selection?.kind==='pin'?model.pins.get(selection.id)?.component:null;
  const hidden=showPassives?[]:circuit.components.filter(c=>c.ref!==explicit&&isSupportPassive(model,c));
  const refs=new Set(hidden.map(c=>c.ref));
  return {...circuit,components:circuit.components.filter(c=>!refs.has(c.ref)),nets:circuit.nets.map(n=>({...n,pins:n.pins.filter(p=>!refs.has(p.component))})),hidden};
}
export function powerTopology(model,{showPassives=false}={}){
  const rails=model.rails.filter(r=>r.supplies.length||r.sources.length);
  const depth=(r,path=new Set())=>{if(path.has(r.net))return 0;const next=new Set([...path,r.net]);return r.inputs.length?1+Math.max(0,...r.inputs.map(n=>{const p=rails.find(x=>x.net===n);return p?depth(p,next):0;})):0;};
  return rails.map(rail=>{
    const sources=[...new Set(rail.sources.map(id=>model.pins.get(id)?.component).filter(Boolean))];
    // An external rail enters through its connector: a power connector category or a J/P/CN/X designator.
    if(!sources.length&&rail.supplies.some(s=>s.externally_driven))for(const ref of rail.loads){const category=model.components.get(ref).partDefinition.category||'';if(category.startsWith('connector.')&&/battery|power/.test(category)||category==='power.source'||/^(J|P|CN|X)(\d|_)/.test(ref.split('/').pop()))sources.push(ref);}
    const receivers=rail.loads.filter(ref=>!sources.includes(ref)),passives=receivers.filter(ref=>isPassive(model.components.get(ref))&&!rail.feeds?.includes(ref));
    return {rail,sources,receivers:receivers.filter(ref=>showPassives||!passives.includes(ref)),passives,depth:depth(rail)};
  }).sort((a,b)=>a.depth-b.depth||a.rail.net.localeCompare(b.rail.net));
}
const array=(x,label)=>{if(!Array.isArray(x))throw Error(`Electrical IR: ${label} must be an array`);return x;};
const text=(x,label)=>{if(typeof x!=='string'||!x.length)throw Error(`Electrical IR: invalid ${label}`);return x;};
const unique=a=>[...new Set(a)];
export function electricalModel(ir) {
  if(ir?.schema!==IR_SCHEMA||ir.kind!=='board')throw Error(`Expected a board with schema ${IR_SCHEMA}`);
  text(ir.name,'board name');
  const components=new Map(),pins=new Map(),netNodes=[],supplies=[],interfaces=[],peripherals=[],states=[],warnings=[];
  const definitions=new Map(array(ir.module_definitions||[],'module_definitions').map(d=>[d.name,d]));
  const parent=new Map(),labels=new Map(),modulePorts=new Set();
  function find(k){if(!parent.has(k))parent.set(k,k);let r=k;while(parent.get(r)!==r)r=parent.get(r);while(parent.get(k)!==k){const n=parent.get(k);parent.set(k,r);k=n;}return r;}
  function join(a,b){a=find(a);b=find(b);if(a!==b)parent.set(b,a);}
  const scoped=(scope,s)=>scope?`${scope}/${s}`:s;
  const node=(scope,s)=>`${scope}::${s}`;
  let instances=0;
  function visit(board,scope,stack=[]) {
    if(stack.length>32||++instances>10000)throw Error('Electrical IR module expansion limit exceeded');
    const parts=new Map(array(board.parts,'parts').map(p=>[p.name,p]));
    const devices=new Map((board.devices||[]).map(d=>[d.name,d]));
    for(const c of array(board.components,'components')){
      const ref=scoped(scope,text(c.ref,'component ref'));if(components.has(ref))throw Error(`Duplicate component ${ref}`);
      const part=parts.get(c.part);if(!part)throw Error(`Missing part ${c.part} for ${ref}`);
      const device=devices.get(part.device);const item={...c,ref,scope,partDefinition:part,pins:[]};components.set(ref,item);
      for(const p of array(part.pins,`${ref} pins`)){
        text(p.name,'pin name');const id=`${ref}.${p.name}`;if(pins.has(id))throw Error(`Duplicate pin ${id}`);
        const bond=p.bonds?.find(b=>!b.when)||p.bonds?.[0];const pad=device?.pads?.find(d=>d.name===bond?.pad);
        const pin={...p,id,component:ref,profile:p.profile||pad?.profile||{},unpowered_behavior:pad?.unpowered_behavior||'unknown',net:null};
        item.pins.push(pin);pins.set(id,pin);
      }
    }
    const seen=new Set(),connectedPins=new Map();
    for(const n of array(board.nets,'nets')){
      text(n.name,'net name');if(seen.has(n.name))throw Error(`Duplicate net ${scoped(scope,n.name)}`);seen.add(n.name);
      const key=node(scope,`net:${n.name}`),name=scoped(scope,n.name);find(key);labels.set(key,name);
      const endpoints=array(n.endpoints,`${name} endpoints`);
      for(const e of endpoints){text(e,'endpoint');const id=scoped(scope,e);if(pins.has(id)&&connectedPins.has(id)&&connectedPins.get(id)!==n.name)throw Error(`Pin ${id} occurs on multiple nets`);if(pins.has(id))connectedPins.set(id,n.name);join(key,node(scope,`endpoint:${e}`));}
      netNodes.push({key,name,scope,endpoints});
    }
    for(const s of board.supplies||[]){if(!seen.has(s.net))throw Error(`Supply ${s.name} refers to missing net ${s.net}`);supplies.push({...s,name:scoped(scope,s.name),key:node(scope,`net:${s.net}`),source:s.source?scoped(scope,s.source):null});}
    for(const i of board.interfaces||[]){const signals=Object.fromEntries(Object.entries(i.signals||{}).map(([s,n])=>{if(!seen.has(n))throw Error(`Interface ${i.name} refers to missing net ${n}`);return [s,node(scope,`net:${n}`)];}));interfaces.push({...i,id:`interface:${scoped(scope,i.name)}`,name:scoped(scope,i.name),scope,signalKeys:signals,provenance:'Declared interface',componentRefs:Object.keys(i.bindings||{}).map(r=>scoped(scope,r))});}
    for(const p of board.peripheral_selections||[])peripherals.push({...p,id:`peripheral:${scoped(scope,p.name)}`,name:scoped(scope,p.name),component:scoped(scope,p.component),provenance:'Configured peripheral'});
    for(const s of board.power_states||[])states.push({name:scoped(scope,s.name),rails:Object.fromEntries(Object.entries(s.rails).map(([n,v])=>{const supply=(board.supplies||[]).find(x=>x.name===n);return [node(scope,`net:${supply?.net||n}`),v];}))});
    for(const instance of board.module_instances||[]){const def=definitions.get(instance.module);if(!def)throw Error(`Missing module ${instance.module}`);if(stack.includes(def.name))throw Error(`Recursive module ${def.name}`);
      const child=scoped(scope,instance.ref);visit(def,child,[...stack,def.name]);
      for(const port of Object.keys(def.ports||{})){modulePorts.add(scoped(scope,`${instance.ref}.${port}`));join(node(scope,`endpoint:${instance.ref}.${port}`),node(child,`endpoint:port.${port}`));}
    }
  }
  visit(ir,'');
  const groups=new Map();for(const n of netNodes){const key=find(n.key);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(n);}
  const nets=new Map(),byKey=new Map();
  for(const group of groups.values()){
    group.sort((a,b)=>a.scope.split('/').length-b.scope.split('/').length||a.scope.length-b.scope.length||a.name.localeCompare(b.name));
    const name=group[0].name,n={name,aliases:group.map(x=>x.name),pins:[],supplies:[],unresolved:[]};nets.set(name,n);
    for(const g of group){byKey.set(find(g.key),n);for(const e of g.endpoints){const id=scoped(g.scope,e);if(e.startsWith('port.'))continue;
      const pin=pins.get(id);if(pin){if(pin.net&&pin.net!==name)throw Error(`Pin ${id} occurs on multiple nets`);pin.net=name;if(!n.pins.includes(pin))n.pins.push(pin);}
      else if(!modulePorts.has(id))n.unresolved.push(id);
    }}
  }
  for(const n of nets.values())if(n.unresolved.length)warnings.push(`${n.name}: unresolved endpoints: ${unique(n.unresolved).join(', ')}`);
  for(const s of supplies){const n=byKey.get(find(s.key));if(s.source&&!pins.has(s.source))warnings.push(`Unresolved supply source ${s.source}`);n.supplies.push(s);}
  const supplyNets=new Set([...nets.values()].filter(n=>n.supplies.length||n.pins.some(p=>p.profile.domains?.includes('power'))).map(n=>n.name));
  // A declared non-zero supply is never ground, even when generic connector pins claim both domains.
  const ground=n=>n.supplies.some(s=>s.voltage?.base_value==='0')||!n.supplies.some(s=>Number(s.voltage?.base_value))&&n.pins.some(p=>p.profile.domains?.includes('ground'));
  const rails=[...nets.values()].filter(n=>supplyNets.has(n.name)&&!ground(n)).map(n=>{
    const declared=unique(n.supplies.map(s=>s.source).filter(Boolean));const output=n.pins.filter(p=>p.profile.domains?.includes('power')&&p.profile.directions?.includes('output')).map(p=>p.id);
    const sources=unique([...declared,...output]);
    const producers=unique(sources.map(p=>pins.get(p)?.component).filter(Boolean));
    const inputs=unique(producers.flatMap(r=>components.get(r).pins.filter(p=>p.net&&p.net!==n.name&&p.profile.domains?.includes('power')&&p.profile.directions?.some(d=>['input','bidirectional'].includes(d))).map(p=>p.net)));
    const controls=producers.flatMap(r=>components.get(r).pins.filter(p=>p.net&&/^(EN|ENABLE|CE|OE)(_N|B)?$/i.test(p.name)));
    return {net:n.name,sources,declaredSources:declared,inputs,controls,loads:unique(n.pins.map(p=>p.component)).filter(r=>!producers.includes(r)),supplies:n.supplies,through:[],feeds:[]};
  });
  // A passive two-terminal part between two supply rails (fuse, inductor, ferrite, shunt, diode) passes
  // power on: it sources the downstream rail and loads the upstream one. Diodes run anode to
  // cathode; other parts run from the rail that already has a source, on-board sources first.
  const railOf=new Map(rails.filter(r=>r.supplies.length||r.sources.length).map(r=>[r.net,r])),links=[];
  for(const c of components.values()){
    const ps=c.pins.filter(p=>p.net);
    if(ps.length!==2||ps[0].net===ps[1].net||!ps.every(p=>railOf.has(p.net)&&(p.profile.directions||[]).every(d=>d==='passive'))||/F$/.test(c.value?.unit||''))continue;
    const a=ps.find(p=>p.name==='A'),k=ps.find(p=>p.name==='K');links.push({ref:c.ref,pins:ps,fixed:a&&k?[a,k]:null});
  }
  // A declared source naming a module port (PWR.VOUT) is not a driver; only resolved pins count.
  const fed=(r,external)=>r.sources.some(id=>pins.has(id))||external&&r.supplies.some(s=>s.externally_driven);
  for(const external of [false,true])for(let changed=true;changed;){
    changed=false;
    for(const l of links){
      if(l.done)continue;let order=l.fixed;
      if(!order){const [p,q]=l.pins,fp=fed(railOf.get(p.net),external),fq=fed(railOf.get(q.net),external);order=fp&&!fq?[p,q]:fq&&!fp?[q,p]:null;}
      if(!order)continue;
      const [i,o]=order,up=railOf.get(i.net),down=railOf.get(o.net);
      down.sources.push(o.id);down.through.push(l.ref);down.inputs=unique([...down.inputs,up.net]);down.loads=down.loads.filter(r=>r!==l.ref);up.feeds.push(l.ref);
      l.done=changed=true;
    }
  }
  const buses=interfaces.map(i=>({...i,signals:Object.fromEntries(Object.entries(i.signalKeys).map(([s,k])=>[s,byKey.get(find(k)).name]))}));
  for(const p of peripherals){const c=components.get(p.component);if(!c)throw Error(`Unknown peripheral component ${p.component}`);
    const signals={};for(const [s,v]of Object.entries(p.signals||{})){const pin=c.pins.find(x=>x.name===(v.pin||v.pad));if(!pin)throw Error(`Unknown peripheral pin ${p.component}.${v.pin||v.pad}`);if(pin.net)signals[s]=pin.net;}
    buses.push({...p,type:p.peripheral,signals,componentRefs:[p.component]});
  }
  // Keep unclassified connections discoverable without inventing a protocol.
  const covered=new Set(buses.flatMap(b=>Object.values(b.signals)));
  for(const n of nets.values())if(!covered.has(n.name)&&!supplyNets.has(n.name)&&!ground(n)&&unique(n.pins.map(p=>p.component)).length>1)buses.push({id:`net:${n.name}`,name:n.name,type:'Unclassified signal',provenance:'Net membership',signals:{signal:n.name},componentRefs:[]});
  for(const b of buses){b.nets=unique(Object.values(b.signals));const pending=[...b.nets],visited=new Set(pending);while(pending.length){const n=nets.get(pending.shift());for(const p of n.pins){const c=components.get(p.component);if(/translator|filter|choke/.test(c.partDefinition.category||''))for(const pin of c.pins)if(pin.net&&!supplyNets.has(pin.net)&&!ground(nets.get(pin.net))&&!visited.has(pin.net)){visited.add(pin.net);pending.push(pin.net);}}}b.pathNets=[...visited];b.componentRefs=unique([...b.componentRefs,...b.pathNets.flatMap(n=>nets.get(n).pins.map(p=>p.component))]);}
  const powerStates=states.map(s=>({name:s.name,rails:Object.fromEntries(Object.entries(s.rails).map(([k,v])=>{const n=byKey.get(find(k));if(!n)throw Error(`Unknown state rail in ${s.name}`);return [n.name,v];}))}));
  return {name:ir.name,ir,components,pins,nets,rails,buses,powerStates,warnings,supplyNets};
}
export function focusCircuit(model,selection,focusRef) {
  let seed=[];
  if(selection?.kind==='bus')seed=model.buses.find(b=>b.id===selection.id)?.pathNets||[];
  else if(selection?.kind==='net')seed=[selection.id];
  else if(selection?.kind==='pin')seed=[model.pins.get(selection.id)?.net].filter(Boolean);
  const ref=selection?.kind==='component'?selection.id:focusRef;
  if(!seed.length&&model.components.has(ref))seed=model.components.get(ref).pins.map(p=>p.net).filter(n=>n&&!model.supplyNets.has(n)&&!model.nets.get(n).pins.some(p=>p.profile.domains?.includes('ground')));
  const selectedNets=new Set(seed),refs=new Set();for(const n of seed)for(const p of model.nets.get(n)?.pins||[])refs.add(p.component);
  // One hop: support components are visible without traversing the whole ground/rail fanout.
  if(selection?.kind==='component'&&ref)refs.add(ref);
  return {nets:[...selectedNets].map(n=>model.nets.get(n)).filter(Boolean),components:[...refs].map(r=>model.components.get(r)).filter(Boolean)};
}
