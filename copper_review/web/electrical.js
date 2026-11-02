import {powerGraph,busGraph,layoutGraph,routeGraph} from './topology.js';
import {electricalModel,focusCircuit,compactCircuit,powerTopology,isPassive,quantity,ELECTRICAL_SCHEMA} from './electrical-model.js';
import {schematicSheets,layoutSheet} from './schematic.js';

const $=id=>document.getElementById(id);
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const distinct=a=>[...new Set(a)];
const json=x=>JSON.stringify(x,null,2);
function download(name,value){const u=URL.createObjectURL(new Blob([json(value)+'\n'],{type:'application/json'}));const a=el('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
export function createElectricalReview({message,onMode}){
  const root=$('electrical-review');
  let model,input,selection=null,focusSelection=null,view='focus',focusRef=null,powerState='',notes=[],detail='intent',editing=null;
  let pendingNote='',pendingDesired='',storageWarning='';
  let showPassives=false,history=[],schematicZoom=1;
  let powerConnections=false,powerZoom=1,busConnections=false,busZoom=1;
  let nativeCheck=null,powerDrawing=new Map(),busDrawing=new Map(),schematic=null,sheetId=null,sheetZoom=1,reveal=null;
  const button=(label,action,cls)=>{const b=el('button',label,cls);b.type='button';b.onclick=action;return b;};
  const key=()=>`copper-review:electrical:v1:${input.sha256}`;
  function selected(kind,id){return selection?.kind===kind&&selection.id===id;}
  function choose(kind,id){selection={kind,id};if(kind==='component')focusRef=id;save();render();for(const pane of root.querySelectorAll('.electrical-sidebar>section'))pane.scrollTo(0,0);}
  function focusEntity(kind,id){if(focusSelection)history.push({focusSelection:{...focusSelection},selection:selection?{...selection}:null,view});focusSelection={kind,id};view='focus';choose(kind,id);$('electrical-canvas').scrollTo(0,0);}
  function group(parent,items,makeItem,hidden,label){const folded=items.filter(hidden),shown=items.filter(x=>!hidden(x));for(const x of shown)parent.append(makeItem(x));if(folded.length){const d=el('details',undefined,'electrical-folded');d.append(el('summary',`${folded.length} ${label}`));for(const x of folded)d.append(makeItem(x));parent.append(d);}}
  function entity(kind,id,label=id){const b=button(label,()=>choose(kind,id),'electrical-entity');b.dataset.kind=kind;b.dataset.entity=id;b.setAttribute('aria-pressed',selected(kind,id));return b;}
  function save(){if(!input)return;try{localStorage.setItem(key(),json({view,selection,focusSelection,focusRef,powerState,notes,showPassives}));storageWarning='';}catch{storageWarning='Browser storage unavailable/full. Export notes to keep them.';}}
  function validSelection(s){return s&&({component:model.components,pin:model.pins,net:model.nets}[s.kind]?.has(s.id)||s.kind==='bus'&&model.buses.some(b=>b.id===s.id));}
  function activeNets(){if(!selection)return [];if(selection.kind==='net')return [selection.id];if(selection.kind==='pin')return [model.pins.get(selection.id).net].filter(Boolean);if(selection.kind==='bus')return model.buses.find(b=>b.id===selection.id).pathNets;return distinct(model.components.get(selection.id).pins.map(p=>p.net).filter(Boolean));}
  function stateOf(name){return model.powerStates.find(s=>s.name===powerState)?.rails[name]||'unspecified';}
  function load(envelope){
    if(envelope?.schema!==ELECTRICAL_SCHEMA||!envelope.input||!/^([a-f0-9]{64})$/.test(envelope.input.sha256))throw Error('Invalid electrical input identity');
    const next=electricalModel(envelope.ir); // Validate completely before replacing the current document.
    nativeCheck=envelope.analysis?.check||null;powerDrawing=new Map();busDrawing=new Map();schematic=null;sheetId=null;sheetZoom=1;
    model=next;input=envelope.input;selection=null;view='schematic';powerState='';notes=[];focusRef=model.components.keys().next().value||null;editing=null;pendingNote='';pendingDesired='';detail='intent';focusSelection=null;history=[];showPassives=false;schematicZoom=1;powerConnections=false;powerZoom=1;busConnections=false;busZoom=1;
    try{const raw=localStorage.getItem(key());if(raw){const saved=JSON.parse(raw);if(!saved||!Array.isArray(saved.notes)||saved.notes.some(n=>!n||!validSelection(n.selection)||typeof n.observation!=='string'))throw Error('Invalid local notes');notes=saved.notes;selection=validSelection(saved.selection)?saved.selection:null;view=['schematic','focus','power','bus'].includes(saved.view)?saved.view:'schematic';powerState=model.powerStates.some(s=>s.name===saved.powerState)?saved.powerState:'';focusRef=model.components.has(saved.focusRef)?saved.focusRef:focusRef;}}
    catch{storageWarning='Saved electrical review could not be read. Existing storage was left untouched.';}
    const initial=model.buses.find(b=>b.provenance==='Configured peripheral')||model.buses[0];if(!selection)selection=initial?{kind:'bus',id:initial.id}:focusRef?{kind:'component',id:focusRef}:null;
    focusSelection=selection;
    try{const saved=JSON.parse(localStorage.getItem(key())||'null');if(validSelection(saved?.focusSelection))focusSelection=saved.focusSelection;showPassives=saved?.showPassives===true;}catch{}
    show(true);render();$('electrical-canvas').scrollTo(0,0);
  }
  function show(value){root.hidden=!value;$('pcb-review').hidden=value;$('electrical-tabs').hidden=!value;onMode(value,model);}
  function render(){
    $('electrical-name').textContent=model.name;
    $('electrical-meta').textContent=`${model.components.size} components · ${model.nets.size} nets · ${input.sha256.slice(0,12)} · electrical IR`;
    for(const b of root.querySelectorAll('[data-electrical-view]')){b.classList.toggle('active',b.dataset.electricalView===view);b.setAttribute('aria-selected',b.dataset.electricalView===view);}
    const picker=$('electrical-focus');picker.replaceChildren();
    for(const [label,items]of [['Interfaces',model.buses.filter(b=>b.provenance!=='Net membership').map(b=>['bus',b.id,b.name])],['Components',[...model.components.values()].filter(c=>showPassives||!isPassive(c)||selected('component',c.ref)).map(c=>['component',c.ref,c.ref])],['Rails',model.rails.filter(r=>r.supplies.length||r.sources.length).map(r=>['net',r.net,r.net])]]){const g=el('optgroup');g.label=label;for(const [kind,id,name]of items){const o=el('option',name);o.value=JSON.stringify({kind,id});g.append(o);}picker.append(g);}
    if(focusSelection){const v=JSON.stringify(focusSelection);if(![...picker.options].some(o=>o.value===v)){const o=el('option',focusSelection.id);o.value=v;picker.append(o);}picker.value=v;}
    $('electrical-back').disabled=!history.length;$('electrical-show-passives').checked=showPassives;$('electrical-zoom').hidden=view!=='focus'&&view!=='schematic'&&(view!=='power'||powerConnections)&&(view!=='bus'||busConnections);
    $('electrical-state').replaceChildren(el('option','No state selected'));$('electrical-state').firstChild.value='';for(const s of model.powerStates){const o=el('option',s.name);o.value=s.name;$('electrical-state').append(o);}$('electrical-state').value=powerState;
    $('electrical-state').disabled=!model.powerStates.length;
    $('electrical-title').textContent={schematic:'Schematic',focus:'Focused schematic',power:'Power hierarchy',bus:'Buses & interfaces'}[view];
    $('electrical-disclaimer').textContent=`Nominal values and declared states; ${nativeCheck?`compiler ERC ${nativeCheck.passed?'passed':'has findings'}; no simulation`:'no simulation or ERC run'}. ${storageWarning}`;
    const canvas=$('electrical-canvas'),scroll=[canvas.scrollLeft,canvas.scrollTop];canvas.replaceChildren();({schematic:renderSchematic,focus:renderFocus,power:renderPower,bus:renderBuses})[view](canvas);canvas.scrollTo(...scroll);if(reveal){const target=canvas.querySelector(`.electrical-sch [data-kind="${reveal.kind}"][data-entity="${CSS.escape(reveal.id)}"]`);reveal=null;target?.scrollIntoView({block:'center',inline:'center'});}renderInspector();renderIntent();renderExplorer();
  }
  function renderExplorer(){const query=$('electrical-search').value.toLowerCase(),list=$('electrical-entities');list.replaceChildren();
    const add=(kind,id,label=id)=>{const b=entity(kind,id,label);b.onclick=()=>view==='schematic'?locate(kind,id):focusEntity(kind,id);return b;};
    for(const b of model.buses)if(b.provenance!=='Net membership'&&b.name.toLowerCase().includes(query))list.append(add('bus',b.id,b.name));
    const matches=[...model.components.values()].filter(c=>`${c.ref} ${c.part}`.toLowerCase().includes(query));group(list,matches,c=>add('component',c.ref),c=>!query&&!showPassives&&isPassive(c),'passive components');
    const railNames=new Set(model.rails.filter(r=>r.sources.length||r.supplies.length).map(r=>r.net));const nets=[...model.nets.values()].filter(n=>n.name.toLowerCase().includes(query));group(list,nets,n=>add('net',n.name),n=>!query&&!railNames.has(n.name),'other nets');
  }
  function sheets(){if(!schematic||schematic.showPassives!==showPassives)schematic={showPassives,...schematicSheets(model,{showPassives}),layouts:new Map()};return schematic;}
  /** Open the sheet that shows an entity, select it and scroll it into view. */
  function locate(kind,id){
    const s=sheets(),ref=kind==='component'?id:kind==='pin'?model.pins.get(id)?.component:null;
    const nets=kind==='net'?[id]:kind==='bus'?model.buses.find(b=>b.id===id)?.pathNets||[]:[];
    const target=ref?s.sheetOf.get(ref):s.sheets.find(sh=>sh.refs.some(r=>model.components.get(r).pins.some(p=>nets.includes(p.net))))?.id;
    if(target)sheetId=target;reveal=ref&&!s.folded.has(ref)?{kind:'component',id:ref}:kind==='net'?{kind:'net',id}:null;choose(kind,id);
  }
  function renderSchematic(canvas){
    const s=sheets();if(!s.sheets.length){canvas.append(el('p','No components in this IR.'));return;}
    if(!s.sheets.some(x=>x.id===sheetId)){const ref=selection?.kind==='component'?selection.id:selection?.kind==='pin'?model.pins.get(selection.id).component:null;sheetId=s.sheetOf.get(ref)||s.sheets[0].id;}
    const sheet=s.sheets.find(x=>x.id===sheetId),bar=el('div',undefined,'electrical-sheet-bar'),label=el('label','Sheet','field'),pick=el('select');pick.id='electrical-sheet';
    for(const [i,x]of s.sheets.entries()){const o=el('option',`${i+1} / ${s.sheets.length} · ${x.title} · ${x.refs.length} parts`);o.value=x.id;pick.append(o);}
    pick.value=sheetId;pick.onchange=()=>{sheetId=pick.value;render();$('electrical-canvas').scrollTo(0,0);};label.append(pick);
    bar.append(label,el('p','Generated from the IR, not an authored drawing. Power and ground pins are flags; nets that would cross a symbol use labels. Sheets split the board by connectivity.','quiet'));canvas.append(bar);
    if(!s.layouts.has(sheetId))s.layouts.set(sheetId,layoutSheet(model,sheet,s));
    const L=s.layouts.get(sheetId),active=new Set(activeNets());
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.classList.add('electrical-topology','electrical-sch');svg.setAttribute('role','group');svg.setAttribute('aria-label',`Generated schematic sheet ${sheet.title}`);
    function draw(tag,attrs,label,parent=svg){const e=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);if(label!==undefined)e.textContent=label;parent.append(e);return e;}
    function pickable(e,kind,id,title){e.dataset.kind=kind;e.dataset.entity=id;e.setAttribute('role','button');e.setAttribute('tabindex','0');e.setAttribute('aria-label',title||id);e.classList.add('electrical-svg-pick');e.onclick=event=>{event.stopPropagation();choose(kind,id);};e.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();choose(kind,id);}};if(title)draw('title',{},title,e);return e;}
    const net=n=>active.has(n)?' selected':'',short=(v,max=26)=>v.length>max?'…'+v.slice(-(max-1)):v;
    const wires=draw('g',{class:'electrical-sch-wires'}),parts=draw('g',{});
    for(const w of L.wires){const g=draw('g',{'data-net':w.net},undefined,wires),d=w.segments.map(([a,b,c,e])=>`M${a} ${b}L${c} ${e}`).join('');draw('path',{d,class:`electrical-sch-wire${net(w.net)}`},undefined,g);pickable(draw('path',{d,class:'electrical-graph-hit'},undefined,g),'net',w.net,w.net);for(const [x,y]of w.dots)draw('circle',{cx:x,cy:y,r:2.6,class:`electrical-sch-dot${net(w.net)}`},undefined,g);if(w.offsheet)pickable(draw('text',{x:w.offsheet.x,y:w.offsheet.y-4,'text-anchor':w.offsheet.anchor,class:`electrical-sch-label${net(w.net)}`},`${short(w.net)} ↗`,g),'net',w.net,`${w.net} continues on other sheets`);}
    for(const l of L.labels){const g=draw('g',{},undefined,wires);draw('path',{d:`M${l.x0} ${l.y}L${l.x} ${l.y}`,class:`electrical-sch-stub${net(l.net)}`},undefined,g);pickable(draw('text',{x:l.x+(l.anchor==='start'?4:-4),y:l.y+4,'text-anchor':l.anchor,class:`electrical-sch-label${net(l.net)}`},`${short(l.net)}${l.offsheet?' ↗':''}`,g),'net',l.net,l.offsheet?`${l.net} (also on other sheets)`:l.net);}
    for(const n of L.notes)pickable(draw('text',{x:n.x,y:n.y,'text-anchor':n.anchor,class:'electrical-sch-note'},n.text,wires),'component',n.refs[0],n.title);
    for(const sym of L.symbols){
      const g=pickable(draw('g',{'data-symbol':sym.ref},undefined,parts),'component',sym.ref,`${sym.ref} · ${sym.part}`),cls=`electrical-sch-symbol${selected('component',sym.ref)?' selected':''}`;
      draw('rect',{x:sym.x,y:sym.y,width:sym.w,height:sym.h,rx:sym.two?3:4,class:cls},undefined,g);
      if(sym.two){const inline=sym.inline,tx=inline?sym.x:sym.x+sym.w+8;draw('text',{x:tx,y:inline?sym.y-5:sym.y+sym.h/2-2,class:'electrical-sch-ref'},sym.title,g);draw('text',{x:tx,y:inline?sym.y+sym.h+13:sym.y+sym.h/2+11,class:'electrical-sch-meta'},sym.subtitle,g);}
      else{draw('text',{x:sym.x+8,y:sym.y+16,class:'electrical-sch-ref'},sym.title,g);draw('text',{x:sym.x+8,y:sym.y+31,class:'electrical-sch-meta'},short(sym.subtitle,Math.floor((sym.w-16)/6.5)),g);if(sym.nc)draw('text',{x:sym.x+8,y:sym.y+sym.h-5,class:'electrical-sch-meta'},`${sym.nc} unconnected pin${sym.nc>1?'s':''}`,g);}
      for(const p of sym.pins){draw('path',{d:`M${p.x} ${p.y}L${p.end} ${p.y}`,class:`electrical-sch-stub${net(p.net)}`},undefined,g);if(!sym.two)pickable(draw('text',{x:p.side==='left'?p.x+6:p.x-6,y:p.y+4,'text-anchor':p.side==='left'?'start':'end',class:`electrical-sch-pin${selected('pin',p.id)?' selected':''}`},p.name,g),'pin',p.id,`${p.id} · pin ${p.number||'?'} · ${p.net}`);}
      for(const f of sym.top){const t=pickable(draw('g',{},undefined,g),'net',f.net,`${f.net} · ${f.names.join(', ')}${f.badges.length?` · folded: ${f.badges.join(', ')}`:''}`);draw('path',{d:`M${f.x} ${f.y}L${f.x} ${f.end}M${f.x-9} ${f.end}L${f.x+9} ${f.end}`,class:`electrical-sch-power${net(f.net)}`},undefined,t);draw('text',{x:f.x,y:f.end-5,'text-anchor':f.anchor,class:'electrical-sch-rail'},short(f.net,14),t);if(f.names.length>1)draw('text',{x:f.x+4,y:f.y-3,class:'electrical-sch-meta'},`×${f.names.length}`,t);if(f.badges.length)draw('text',{x:f.x-4,y:f.y-3,'text-anchor':'end',class:'electrical-sch-note'},`C×${f.badges.length}`,t);}
      for(const f of sym.bottom){const t=pickable(draw('g',{},undefined,g),'net',f.net,`${f.net} · ${f.names.join(', ')}`);draw('path',{d:`M${f.x} ${f.y}L${f.x} ${f.end}M${f.x-9} ${f.end}L${f.x+9} ${f.end}M${f.x-6} ${f.end+4}L${f.x+6} ${f.end+4}M${f.x-3} ${f.end+8}L${f.x+3} ${f.end+8}`,class:`electrical-sch-ground${net(f.net)}`},undefined,t);if(!/^GND$/i.test(f.net))draw('text',{x:f.x,y:f.end+21,'text-anchor':f.anchor,class:'electrical-sch-meta'},short(f.net,14),t);if(f.names.length>1)draw('text',{x:f.x+4,y:f.y+12,class:'electrical-sch-meta'},`×${f.names.length}`,t);}
    }
    svg.setAttribute('viewBox',`0 0 ${L.width} ${L.height}`);svg.dataset.naturalWidth=L.width;svg.dataset.naturalHeight=L.height;svg.style.width=`${L.width*sheetZoom}px`;svg.style.height=`${L.height*sheetZoom}px`;canvas.append(svg);
    const here=[...s.folded.values()].filter(f=>s.sheetOf.get(f.ref)===sheetId);
    if(here.length){const d=el('details',undefined,'electrical-folded');d.append(el('summary',`${here.length} passives folded on this sheet: decoupling shows as C×n by rail flags, pull resistors as ↑/↓ notes. Show passives draws them.`));for(const f of here)d.append(entity('component',f.ref,`${f.ref} · ${quantity(model.components.get(f.ref).value)} · ${f.kind==='support'?`support on ${f.net}${f.pin?` for ${f.pin}`:''}`:`${f.kind==='pullup'?'pull-up':'pull-down'} ${f.net} → ${f.rail}`}`));canvas.append(d);}
  }
  function netHeader(n){const h=el('div',undefined,'electrical-net-heading');h.append(entity('net',n.name));const q=distinct(n.supplies.map(s=>quantity(s.voltage)));if(q.length)h.append(el('span',q.join(' / ')+' nominal','quiet'));return h;}
  function pinTerminal(p){const box=el('div',undefined,'electrical-terminal');box.append(entity('component',p.component),entity('pin',p.id,`${p.name} · pin ${p.number||'unspecified'}`));const c=model.components.get(p.component);box.append(el('small',c.value?quantity(c.value):c.part,'quiet'));return box;}
  function renderFocus(canvas){
    const full=focusCircuit(model,focusSelection,focusRef),circuit=compactCircuit(model,full,showPassives,focusSelection);
    canvas.append(el('p','Electrical slice · pins and nets from the IR. Select a terminal or wire to inspect it.','quiet'));
    if(circuit.hidden.length){const d=el('details',undefined,'electrical-folded');d.append(el('summary',`${circuit.hidden.length} supporting passives collapsed`));for(const c of circuit.hidden)d.append(entity('component',c.ref,`${c.ref} · ${quantity(c.value)}`));canvas.append(d);}
    if(circuit.components.length&&circuit.components.length<=8&&circuit.nets.length<=24)renderTopology(canvas,circuit);
    const connections=el('details',undefined,'electrical-connections');connections.open=circuit.components.length>8||circuit.nets.length>24;connections.append(el('summary','Net-by-net connections (all terminals)'));canvas.append(connections);
    if(!circuit.nets.length)canvas.append(el('p','Select a connected pin, net or interface to focus the circuit.'));
    for(const n of full.nets){const section=el('section',undefined,'electrical-net');section.append(netHeader(n));const wire=el('div',undefined,'electrical-wire');
      for(const p of [...n.pins].sort((a,b)=>(b.profile.directions?.includes('output')||false)-(a.profile.directions?.includes('output')||false)||a.component.localeCompare(b.component)))wire.append(pinTerminal(p));
      section.append(wire);if(n.unresolved.length)section.append(el('p','Unresolved endpoints: '+n.unresolved.join(', '),'electrical-warning'));connections.append(section);
    }
    if(circuit.components.length){const support=el('details');support.append(el('summary','Component pins, supplies & support'));for(const c of circuit.components){const s=el('section',undefined,'electrical-support');s.append(entity('component',c.ref),el('div',c.part,'quiet'));const pins=el('div',undefined,'electrical-chips');for(const p of c.pins)if(p.net&&model.supplyNets.has(p.net))pins.append(entity('pin',p.id,`${p.name} → ${p.net}`));s.append(pins);for(const dec of model.components.values()){const target=dec.properties?.decouples;if(typeof target==='string'&&dec.scope===c.scope&&target.startsWith(c.ref.split('/').pop()+'.'))s.append(entity('component',dec.ref,`${dec.ref} · ${quantity(dec.value)} · ${target}`));}support.append(s);}canvas.append(support);}
    canvas.append(el('p','Focus boundary: one net hop, or the selected interface path. Expand a component to inspect its other connections.','quiet'));
  }
  function renderTopology(canvas,circuit){
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.classList.add('electrical-topology');svg.setAttribute('role','group');svg.setAttribute('aria-label','Focused electrical schematic with component pin terminals and selectable net wires');
    const refs=circuit.components.map(c=>c.ref);const selectedBus=focusSelection?.kind==='bus'&&model.buses.find(b=>b.id===focusSelection.id);if(selectedBus){refs.sort((a,b)=>selectedBus.componentRefs.indexOf(a)-selectedBus.componentRefs.indexOf(b));}
    const col=340,box=170,left=12,top=95,row=65,width=Math.max(360,refs.length*col-130),height=Math.max(270,top+circuit.nets.length*row+65);svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.dataset.naturalWidth=width;svg.dataset.naturalHeight=height;svg.style.width=`${width*schematicZoom}px`;svg.style.height=`${height*schematicZoom}px`;
    function draw(tag,attrs,label,parent=svg){const e=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);if(label!==undefined)e.textContent=label;parent.append(e);return e;}
    function click(e,kind,id){e.dataset.kind=kind;e.dataset.entity=id;e.setAttribute('role','button');e.setAttribute('tabindex','0');e.setAttribute('aria-label',id);e.classList.add('electrical-svg-pick');e.onclick=()=>choose(kind,id);e.onkeydown=ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();choose(kind,id);}};}
    const positions=new Map();
    for(const [i,ref]of refs.entries()){
      const x=left+i*col,c=model.components.get(ref),g=draw('g',{});draw('rect',{x,y:30,width:box,height:height-55,rx:5,class:'electrical-symbol'},undefined,g);const title=draw('text',{x:x+10,y:54},ref,g);click(title,'component',ref);draw('text',{x:x+10,y:73,class:'electrical-svg-small'},c.part.split('.').pop().slice(0,24),g);
      for(const [index,n]of circuit.nets.entries())for(const p of n.pins.filter(p=>p.component===ref)){
        const other=n.pins.filter(q=>q.component!==ref).map(q=>refs.indexOf(q.component));const side=other.length&&other.every(j=>j<i)?'left':'right',px=side==='left'?x:x+box,py=top+index*row;
        positions.set(p.id,[px,py]);draw('circle',{cx:px,cy:py,r:3,class:'electrical-pin-dot'},undefined,g);const label=draw('text',{x:side==='left'?x+10:x+box-10,y:py-8,'text-anchor':side==='left'?'start':'end'},`${p.name} · ${p.number||'?'}`,g);click(label,'pin',p.id);
      }
    }
    for(const [index,n]of circuit.nets.entries()){
      const points=n.pins.map(p=>positions.get(p.id)).filter(Boolean).sort((a,b)=>a[0]-b[0]);if(points.length<2)continue;const start=points[0],end=points.at(-1),g=draw('g',{});const path=points.map((p,i)=>`${i?'L':'M'}${p[0]},${p[1]}`).join(' ');draw('path',{d:path,class:`electrical-signal ${selected('net',n.name)?'selected':''}`},undefined,g);const hit=draw('rect',{x:start[0],y:start[1]-10,width:Math.max(1,end[0]-start[0]),height:20,fill:'transparent','pointer-events':'all'},undefined,g);click(hit,'net',n.name);const gap=points.findIndex((p,i)=>i&&p[0]-points[i-1][0]>box);const a=gap>0?points[gap-1]:start,b=gap>0?points[gap]:end;const text=draw('text',{x:(a[0]+b[0])/2,y:top+index*row+18,'text-anchor':'middle',class:'electrical-svg-small'},n.name,g);click(text,'net',n.name);
    }
    canvas.append(svg);
  }
  function renderPower(canvas){
    const modes=el('div',undefined,'tabs');const topology=button('Topology',()=>{powerConnections=false;render();$('electrical-canvas').scrollTo(0,0);});topology.id='electrical-power-topology';topology.classList.toggle('active',!powerConnections);const connections=button('Connections',()=>{powerConnections=true;render();$('electrical-canvas').scrollTo(0,0);});connections.id='electrical-power-connections';connections.classList.toggle('active',powerConnections);modes.append(topology,connections);canvas.append(modes);
    if(!powerConnections){renderPowerTopology(canvas);return;}
    const rails=model.rails.filter(r=>r.supplies.length||r.sources.length),railNames=new Set(rails.map(r=>r.net));
    canvas.append(el('p','Parent rails feed power pins on the same source IC. These are inferred dependencies, not verified internal transfer paths.','quiet'));
    const children=new Map(rails.map(r=>[r.net,[]]));for(const r of rails)for(const n of r.inputs)if(children.has(n))children.get(n).push(r);
    const emitted=new Set();
    function rail(r,path){const card=el('section',undefined,'electrical-rail');card.dataset.rail=r.net;const n=model.nets.get(r.net);card.append(netHeader(n));const state=stateOf(r.net);card.append(el('div',`${powerState?`${powerState}: `:''}${state==='unspecified'?'State unspecified':`Declared ${state}`} · ${r.declaredSources.length?'Declared source':r.sources.length?'Source inferred from power-output pin':'External / source unspecified'}`,'quiet'));
      for(const s of r.sources)card.append(entity('pin',s,`Source: ${s}`));
      const inputRow=el('div',undefined,'electrical-chips');for(const s of r.inputs)inputRow.append(entity('net',s,`Power pin on source IC ← ${s}`));card.append(inputRow);
      for(const c of r.controls){const row=el('div',undefined,'electrical-control');row.append(el('span','Control candidate (pin-name inference): '),entity('pin',c.id,c.id),el('span','←'),entity('net',c.net));const controlNet=model.nets.get(c.net),fixed=model.supplyNets.has(c.net)||controlNet.pins.some(p=>p.profile.domains?.includes('ground'));if(!fixed)for(const p of controlNet.pins.filter(p=>p.id!==c.id&&!isPassive(model.components.get(p.component))&&p.profile.directions?.some(d=>['output','bidirectional'].includes(d))))row.append(entity('pin',p.id,p.id));card.append(row);}
      const loads=el('div',undefined,'electrical-loads');const makeLoad=ref=>{const p=n.pins.filter(p=>p.component===ref).map(p=>p.name).join(', ');const row=el('div',undefined,'electrical-load');row.append(entity('component',ref),el('span',p,'quiet'));return row;};group(loads,r.loads,makeLoad,ref=>!showPassives&&isPassive(model.components.get(ref))&&!selected('component',ref),'passive loads');card.append(loads);
      if(path.has(r.net)){card.append(el('p','Cyclic dependency; expand this rail from the root list.','electrical-warning'));return card;}
      emitted.add(r.net);const next=new Set([...path,r.net]);const branch=el('div',undefined,'electrical-branches');for(const child of children.get(r.net)||[])if(!next.has(child.net)){if(emitted.has(child.net)){branch.append(entity('net',child.net,`Shared dependent rail → ${child.net}`));}else branch.append(rail(child,next));}card.append(branch);return card;
    }
    for(const r of rails)if(!r.inputs.some(n=>railNames.has(n)))canvas.append(rail(r,new Set()));
    for(const r of rails)if(!emitted.has(r.net))canvas.append(rail(r,new Set()));
    if(!rails.length)canvas.append(el('p','No declared supplies or power-output rails in this IR.'));
    const aux=model.rails.filter(r=>!railNames.has(r.net));if(aux.length){const d=el('details');d.append(el('summary',`${aux.length} additional power-pin nets (roles unspecified)`));for(const r of aux)d.append(entity('net',r.net));canvas.append(d);}
    canvas.append(el('p','A declared off rail does not establish discharge, isolation or absence of backup power. Only explicitly assigned state values are shown.','quiet'));
  }
  function renderPowerTopology(canvas){
    canvas.append(el('p','One box per device. Dots mark shared rail branches; gaps distinguish crossings.','quiet'));
    renderConnectedGraph(canvas,powerGraph(model,{showPassives}),'power');
  }
  function renderBuses(canvas){
    const modes=el('div',undefined,'tabs');
    for(const [name,connections]of [['Topology',false],['Connections',true]]){const b=button(name,()=>{busConnections=connections;render();$('electrical-canvas').scrollTo(0,0);});b.id=connections?'electrical-bus-connections':'electrical-bus-topology';b.classList.toggle('active',busConnections===connections);modes.append(b);}canvas.append(modes);
    if(busConnections){renderBusConnections(canvas);return;}
    const graph=busGraph(model,{showPassives});
    canvas.append(el('p','One box per device. Named buses group actual signal nets; translator/filter sides stay separate. Dots mark shared branches; gaps distinguish crossings.','quiet'));
    const legend=el('div',undefined,'electrical-bus-legend');legend.setAttribute('aria-label','Bus protocol legend');legend.append(el('span','Bus types','quiet'));
    const protocols=new Map(graph.nodes.filter(n=>!n.device).map(n=>[n.protocol.label,n.protocol]));
    for(const protocol of protocols.values()){const item=el('span',protocol.label,'electrical-bus-key');item.dataset.busProtocol=protocol.key;legend.append(item);}if(protocols.size)canvas.append(legend);
    renderConnectedGraph(canvas,graph,'bus');
    if(graph.otherSignals)canvas.append(el('p',`${graph.otherSignals} other signal nets are available in Connections.`,'quiet'));
  }
  function renderConnectedGraph(canvas,graph,mode){
    if(!graph.nodes.length){canvas.append(el('p',mode==='power'?'No power rails in this IR.':'No declared or configured interfaces. See Connections for other signals.'));return;}
    const drawings=mode==='power'?powerDrawing:busDrawing;
    if(!drawings.has(showPassives)){const layout=layoutGraph(graph);drawings.set(showPassives,{layout,routed:routeGraph(layout)});}
    const {layout,routed}=drawings.get(showPassives);
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.classList.add('electrical-topology','electrical-connected-graph',mode==='power'?'electrical-power-topology':'electrical-bus-topology');svg.setAttribute('role','group');svg.setAttribute('aria-label',mode==='power'?'Connected power topology with one box per device':'Connected bus topology with one box per device');
    function draw(tag,attrs,label,parent=svg){const e=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);if(label!==undefined)e.textContent=label;parent.append(e);return e;}
    function pick(e,kind,id){e.dataset.kind=kind;e.dataset.entity=id;e.setAttribute('role','button');e.setAttribute('tabindex','0');e.setAttribute('aria-label',id);e.classList.add('electrical-svg-pick');e.onclick=()=>choose(kind,id);e.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(kind,id);}};}
    const wires=draw('g',{'class':'electrical-graph-wires'}),boxes=draw('g',{'class':'electrical-graph-boxes'});
    if(mode==='power'){
      const groups=new Map();
      for(const r of routed.routes){if(!groups.has(r.entity))groups.set(r.entity,[]);groups.get(r.entity).push(r);}
      for(const [entity,routes]of [...groups].sort(([a],[b])=>Number(selected('net',a))-Number(selected('net',b)))){
        const d=routes.map(r=>r.points.map((p,i)=>`${i?'L':'M'}${p[0]} ${p[1]}`).join(' ')).join(' '),g=draw('g',{'data-power-net':entity},undefined,wires);
        draw('path',{d,class:'electrical-power-underlay'},undefined,g);
        draw('path',{d,class:`electrical-graph-wire electrical-power-wire${selected('net',entity)?' selected':''}${stateOf(entity)==='off'?' is-off':''}`},undefined,g);
        const hit=draw('path',{d,class:'electrical-graph-hit'},undefined,g);pick(hit,'net',entity);draw('title',{},[entity,...distinct(routes.flatMap(r=>r.pins))].join(' · '),hit);
        for(const j of routed.junctions.filter(j=>j.entity===entity))draw('circle',{cx:j.point[0],cy:j.point[1],r:2.4,class:'electrical-power-junction','pointer-events':'none'},undefined,g);
      }
    }else{
      const groups=new Map();
      for(const r of routed.routes){if(!groups.has(r.bundle))groups.set(r.bundle,[]);groups.get(r.bundle).push(r);}
      for(const [bundle,routes]of [...groups].sort(([,a],[,b])=>Number(selected('bus',a[0].entity))-Number(selected('bus',b[0].entity)))){
        const {entity,protocol}=routes[0],hub=layout.nodes.find(n=>n.id===bundle),d=routes.map(r=>r.points.map((p,i)=>`${i?'L':'M'}${p[0]} ${p[1]}`).join(' ')).join(' ');
        const g=draw('g',{'data-bus-bundle':bundle,'data-bus-protocol':protocol.key},undefined,wires);
        draw('path',{d,class:'electrical-bus-underlay'},undefined,g);
        draw('path',{d,class:`electrical-graph-wire electrical-bus-wire${selected('bus',entity)?' selected':''}`},undefined,g);
        const hit=draw('path',{d,class:'electrical-graph-hit'},undefined,g);pick(hit,'bus',entity);draw('title',{},[hub.label,hub.subtitle,...hub.types,...hub.aliases,...distinct(routes.flatMap(r=>r.pins))].join(' · '),hit);
        for(const j of routed.junctions.filter(j=>j.bundle===bundle))draw('circle',{cx:j.point[0],cy:j.point[1],r:2.4,class:'electrical-bus-junction','pointer-events':'none'},undefined,g);
      }
    }
    const shortened=(value,max=24)=>value.length>max?'…'+value.slice(-(max-1)):value;
    for(const n of layout.nodes){
      const g=draw('g',{'data-topology-node':n.id},undefined,boxes);pick(g,n.kind,n.entity);if(n.device)g.dataset.topologyDevice=n.entity;else if(mode==='power')g.dataset.powerRail=n.entity;else{g.dataset.topologyBus=n.id;g.dataset.busProtocol=n.protocol.key;}
      const title=[n.label,n.subtitle,...(n.aliases||[]),...(n.types||[]),...(n.nets||[]),mode==='power'&&!n.device?`State: ${stateOf(n.entity)}; ${n.passives||0} collapsed passives`:''];draw('title',{},distinct(title).join(' · '),g);
      draw('rect',{x:n.x,y:n.y,width:n.width,height:n.height,rx:n.device?5:15,class:`electrical-graph-node ${n.device?'device':'junction'}${selected(n.kind,n.entity)?' selected':''}`},undefined,g);
      draw('text',{x:n.x+10,y:n.y+20,class:n.device?'':'electrical-net-label'},shortened(n.label,Math.floor((n.width-20)/7)),g);
      draw('text',{x:n.x+10,y:n.y+38,class:'electrical-graph-meta'},shortened(n.subtitle==='Voltage unspecified'?'Unspecified':n.subtitle,Math.floor((n.width-20)/6)),g);
      if(mode==='power'){
        if(n.device){const controls=model.components.get(n.entity).pins.filter(p=>p.net&&/^(EN|ENABLE|CE|OE)(_N|B)?$/i.test(p.name));if(controls.length){const p=controls[0],t=draw('text',{x:n.x+10,y:n.y+56,class:'electrical-graph-meta'},shortened(`${p.name} ← ${p.net}`,26),g);pick(t,'pin',p.id);t.onclick=event=>{event.stopPropagation();choose('pin',p.id);};t.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();choose('pin',p.id);}};}}
        else{const declared=stateOf(n.entity);draw('text',{x:n.x+10,y:n.y+56,class:'electrical-graph-meta'},declared==='unspecified'?'':`Declared ${declared}`,g);if(n.passives)draw('text',{x:n.x+10,y:n.y+71,class:'electrical-graph-meta'},`+${n.passives} passives`,g);}
      }else if(!n.device){
        const aliases=n.aliases.filter(name=>name!==n.label),meta=aliases.length?aliases.join(' / '):n.types.join(' / ');
        draw('text',{x:n.x+10,y:n.y+56,class:'electrical-graph-meta'},shortened(meta,Math.floor((n.width-20)/6)),g);
      }
    }
    const width=layout.width+35,height=layout.height,zoom=mode==='power'?powerZoom:busZoom;
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.dataset.naturalWidth=width;svg.dataset.naturalHeight=height;svg.style.width=`${width*zoom}px`;svg.style.height=`${height*zoom}px`;canvas.append(svg);
  }
  function renderBusConnections(canvas){
    const other=el('details',undefined,'electrical-other-signals');other.append(el('summary',`${model.buses.filter(b=>b.provenance==='Net membership').length} other signal nets`));
    for(const b of model.buses){const card=el('section',undefined,'electrical-bus');const title=entity('bus',b.id,b.name);title.onclick=()=>focusEntity('bus',b.id);card.append(title,el('div',`${b.type} · ${b.provenance}`,'quiet'));const path=el('div',undefined,'electrical-path');group(path,b.componentRefs,r=>entity('component',r),r=>!showPassives&&isPassive(model.components.get(r)),'passive support components');card.append(path);const signals=el('div',undefined,'electrical-chips');for(const [s,n]of Object.entries(b.signals))signals.append(entity('net',n,`${s} → ${n}`));card.append(signals);if(b.pathNets.length>b.nets.length)card.append(el('p','Expanded through translator/filter signal pins; channel correspondence is not inferred.','quiet'));(b.provenance==='Net membership'?other:canvas).append(card);}
    if(other.childElementCount>1)canvas.append(other);
    if(!model.buses.length)canvas.append(el('p','No configured interfaces or connected signal nets in this IR.'));
  }
  function renderInspector(){const inspector=$('electrical-inspector');inspector.replaceChildren();if(!selection){inspector.append(el('p','Select a pin, net, component or interface.'));return;}
    inspector.append(el('h3',selection.id),button('Focus selected circuit',()=>focusEntity(selection.kind,selection.id)));
    const netNames=activeNets();
    if(selection.kind==='pin'){const p=model.pins.get(selection.id);inspector.append(el('p',`Pin ${p.number||'unspecified'} · ${(p.profile.directions||[]).join(', ')||'direction unspecified'} · ${(p.profile.domains||[]).join(', ')||'domain unspecified'}`));inspector.append(el('p',p.net?'Connected':'No net in IR (intent unspecified)','quiet'));const v=p.profile.voltage;if(v)inspector.append(el('p',`Voltage: ${quantity(v.minimum)} … ${quantity(v.maximum)} · ${v.rating||'rating unspecified'}`));inspector.append(el('p',`Unpowered behavior: ${p.unpowered_behavior}`,'quiet'));}
    if(selection.kind==='component'){const c=model.components.get(selection.id);inspector.append(el('p',`${c.part} ${c.value?quantity(c.value):''}`));const table=el('div',undefined,'electrical-pin-list');for(const p of c.pins){const row=el('div');row.append(entity('pin',p.id,`${p.name} · ${p.number||'?'}`));row.append(p.net?entity('net',p.net):el('span',`No net · ${p.connection_policy||'intent unspecified'}`,'quiet'));table.append(row);}inspector.append(table);}
    else for(const name of netNames){const n=model.nets.get(name);inspector.append(entity('net',name));if(n.aliases.length>1)inspector.append(el('p',`Aliases: ${n.aliases.join(', ')}`,'quiet'));group(inspector,n.pins,p=>entity('pin',p.id,`${p.id} · pin ${p.number||'?'}`),p=>!showPassives&&isPassive(model.components.get(p.component))&&!selected('pin',p.id),'passive terminals');}
  }
  function renderIntent(){const box=$('electrical-intent');box.replaceChildren();const tabs=el('div',undefined,'tabs');for(const id of ['intent','source','notes']){const b=button(id[0].toUpperCase()+id.slice(1),()=>{detail=id;renderIntent();});b.classList.toggle('active',detail===id);tabs.append(b);}box.append(tabs);
    if(detail==='notes'){renderNotes(box);return;}
    if(!selection)return;
    const netNames=activeNets(),refs=selection.kind==='component'?[selection.id]:selection.kind==='pin'?[model.pins.get(selection.id).component]:distinct(netNames.flatMap(n=>model.nets.get(n).pins.map(p=>p.component)));
    if(detail==='source'){const source={selection,nets:netNames.map(n=>{const x=model.nets.get(n);return {name:n,aliases:x.aliases,endpoints:x.pins.map(p=>p.id),supplies:x.supplies};}),components:refs.map(r=>{const c=model.components.get(r);return {ref:r,part:c.part,properties:c.properties,source:c.partDefinition.source};})};box.append(el('p','Resolved IR excerpt; not original source text.','quiet'),el('pre',json(source)));return;}
    box.append(el('h3','Declared facts'));
    for(const n of netNames){const net=model.nets.get(n);for(const s of net.supplies)box.append(el('p',`${s.name}: ${quantity(s.voltage)} nominal${s.source?` · source ${s.source}`:s.externally_driven?' · external in this scope':''}`));if(powerState)box.append(el('p',`${n}: ${stateOf(n)} in ${powerState}`,'quiet'));}
    for(const b of model.buses.filter(b=>b.provenance!=='Net membership'&&b.nets.some(n=>netNames.includes(n))))box.append(el('p',`${b.provenance}: ${b.name} · ${b.type}${b.pullup_supply?` · pull-up ${b.pullup_supply}`:''}`));
    for(const r of refs){const c=model.components.get(r);if(!showPassives&&isPassive(c)&&!(selection.kind==='component'&&selection.id===r)&&!(selection.kind==='pin'&&model.pins.get(selection.id).component===r))continue;for(const [k,v]of Object.entries(c.properties||{}))box.append(el('p',`${r} · ${k}: ${typeof v==='object'?json(v):v}`));const src=c.partDefinition.source;if(src?.document){box.append(el('p',`${r}: ${src.document}${src.revision?' · '+src.revision:''}`,'quiet'));if(src.url){try{const u=new URL(src.url);if(['https:','http:'].includes(u.protocol)){const a=el('a','Open source document');a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';box.append(a);}}catch{}}}}
    box.append(el('h3','Review limits'),el('p','Connectivity and ratings come from the IR. Missing purpose, protocol grouping, power sequencing and device behavior remain unspecified. This viewer does not validate them.','quiet'));
    if(model.warnings.length){const d=el('details');d.append(el('summary',`${model.warnings.length} import warnings`));for(const w of model.warnings)d.append(el('p',w));box.append(d);}
  }
  function renderNotes(box){
    for(const [i,n]of notes.entries()){const row=el('div',undefined,'electrical-note');row.append(button(`${n.selection.id}: ${n.observation}`,()=>{selection=n.selection;editing=i;pendingNote=n.observation;pendingDesired=n.desired_behavior||'';detail='notes';render();}),button('Delete',()=>{notes.splice(i,1);editing=null;save();renderIntent();}));box.append(row);}
    const label=el('label','Observation','field'),field=el('textarea');field.id='electrical-observation';field.value=pendingNote;field.oninput=()=>pendingNote=field.value;label.append(field);box.append(label);
    const desired=el('label','Desired behavior','field'),d=el('textarea');d.id='electrical-desired';d.value=pendingDesired;d.oninput=()=>pendingDesired=d.value;desired.append(d);box.append(desired);
    const add=button(editing===null?'Add electrical note':'Save electrical note',()=>{if(!selection||!pendingNote.trim()){message('Select an electrical entity and enter an observation.',true);return;}const old=notes[editing];const note={id:old?.id||crypto.randomUUID(),selection:{...selection},view,power_state:powerState||null,observation:pendingNote.trim(),desired_behavior:pendingDesired.trim(),created_at:old?.created_at||new Date().toISOString(),updated_at:new Date().toISOString()};if(editing===null)notes.push(note);else notes[editing]=note;editing=null;pendingNote='';pendingDesired='';save();renderIntent();});add.id='electrical-save-note';box.append(add,button('Export electrical review',exportReview),el('p','Electrical reviews carry the IR hash and exact entity identities; they use a separate contract from PCB reviews.','quiet'));
  }
  function exportReview(){download(`${model.name}.electrical.review.json`,{schema:'copper-electrical-review/v1',input,selection,view,power_state:powerState||null,annotations:notes});}
  function importReview(value){if(value?.schema!=='copper-electrical-review/v1'||value.input?.sha256!==input?.sha256)throw Error('Electrical review does not match the loaded IR hash');if(!Array.isArray(value.annotations)||value.annotations.some(n=>!n||!validSelection(n.selection)||typeof n.observation!=='string'||typeof n.id!=='string'))throw Error('Invalid electrical review notes');notes=value.annotations;pendingNote='';pendingDesired='';editing=null;save();render();}
  for(const b of root.querySelectorAll('[data-electrical-view]'))b.onclick=()=>{view=b.dataset.electricalView;save();render();};
  $('electrical-focus').onchange=e=>{if(e.target.value){const s=JSON.parse(e.target.value);if(view==='schematic')locate(s.kind,s.id);else focusEntity(s.kind,s.id);}};
  $('electrical-back').onclick=()=>{const prev=history.pop();if(prev){focusSelection=prev.focusSelection;selection=prev.selection;view=prev.view;save();render();}};
  $('electrical-show-passives').onchange=e=>{showPassives=e.target.checked;save();render();};
  $('electrical-fit').onclick=()=>{const svg=root.querySelector('.electrical-topology');if(svg){const c=$('electrical-canvas'),zoom=Math.min(1,Math.max(.15,(c.clientWidth-44)/Number(svg.dataset.naturalWidth)),Math.max(.15,(c.clientHeight-100)/Number(svg.dataset.naturalHeight)));if(view==='power')powerZoom=zoom;else if(view==='bus')busZoom=zoom;else if(view==='schematic')sheetZoom=zoom;else schematicZoom=zoom;render();c.scrollTo(0,0);}};
  // Schematic: wheel zooms under the pointer, right/middle-drag pans (as in the PCB view).
  const sheetSvg=e=>view==='schematic'?e.target.closest?.('#electrical-canvas')?.querySelector('.electrical-sch'):null;
  $('electrical-canvas').addEventListener('wheel',e=>{const svg=sheetSvg(e);if(!svg)return;e.preventDefault();const c=e.currentTarget,before=svg.getBoundingClientRect(),fx=(e.clientX-before.left)/before.width,fy=(e.clientY-before.top)/before.height;const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?c.clientHeight:1);sheetZoom=Math.max(.1,Math.min(4,sheetZoom*Math.exp(-delta*.0015)));svg.style.width=`${Number(svg.dataset.naturalWidth)*sheetZoom}px`;svg.style.height=`${Number(svg.dataset.naturalHeight)*sheetZoom}px`;const after=svg.getBoundingClientRect();c.scrollLeft+=after.left+fx*after.width-e.clientX;c.scrollTop+=after.top+fy*after.height-e.clientY;},{passive:false});
  let sheetPan=null;
  $('electrical-canvas').addEventListener('pointerdown',e=>{if((e.button!==2&&e.button!==1)||!sheetSvg(e))return;e.preventDefault();const c=e.currentTarget;sheetPan={id:e.pointerId,x:e.clientX,y:e.clientY,left:c.scrollLeft,top:c.scrollTop};c.setPointerCapture(e.pointerId);c.classList.add('panning');});
  $('electrical-canvas').addEventListener('pointermove',e=>{if(sheetPan?.id!==e.pointerId)return;const c=e.currentTarget;c.scrollLeft=sheetPan.left-(e.clientX-sheetPan.x);c.scrollTop=sheetPan.top-(e.clientY-sheetPan.y);});
  for(const type of ['pointerup','pointercancel'])$('electrical-canvas').addEventListener(type,e=>{if(sheetPan?.id!==e.pointerId)return;sheetPan=null;e.currentTarget.classList.remove('panning');});
  $('electrical-canvas').addEventListener('contextmenu',e=>{if(sheetSvg(e))e.preventDefault();});
  $('electrical-actual-size').onclick=()=>{if(view==='power')powerZoom=1;else if(view==='bus')busZoom=1;else if(view==='schematic')sheetZoom=1;else schematicZoom=1;render();};
  $('electrical-state').onchange=e=>{powerState=e.target.value;save();render();};
  $('electrical-search').oninput=renderExplorer;
  $('electrical-export').onclick=exportReview;
  $('electrical-load-review').onclick=()=>$('electrical-review-file').click();
  $('electrical-review-file').onchange=async e=>{const f=e.target.files[0];e.target.value='';try{if(f){if(f.size>50*1024*1024)throw Error('Review exceeds 50 MiB');importReview(JSON.parse(await f.text()));}}catch(error){message(error.message,true);}};
  $('show-pcb').onclick=()=>show(false);$('show-electrical').onclick=()=>show(true);
  new ResizeObserver(entries=>{root.style.setProperty('--electrical-header-height',`${entries[0].target.getBoundingClientRect().height}px`);}).observe(document.querySelector('body>header'));
  return {load,show,hasModel:()=>!!model};
}
